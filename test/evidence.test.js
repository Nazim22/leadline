'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appendEvidenceReceipt, createEvidenceContactReceipt, extractReferences, validateEvidenceReceipt,
} = require('../src/evidence');

const EVIDENCE_KEYS = [
  'schema_version', 'evidence_id', 'session_id', 'turn_id', 'tool_call_id', 'provider', 'tool_name',
  'capability', 'args_sha256', 'arg_keys', 'timestamp', 'observed_at', 'result_hash', 'result_nonempty',
  'references', 'failure',
].sort();

const base = {
  session_id: 'sess-1', turn_id: 'turn-1', tool_call_id: 'tc-1',
  toolCall: { provider: 'cli-probe', name: 'curl', args: { url: 'https://example/health', token: 'secret-xyz' } },
  result: { value: 'api is live, tests 37/37', observed_at: '2026-07-23T05:00:00.000Z' },
  now: new Date('2026-07-23T05:01:00.000Z'),
};

test('evidence-contact receipt is a frozen, exact-keys, canonically-hashed object', () => {
  const receipt = createEvidenceContactReceipt(base);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Object.keys(receipt).sort(), EVIDENCE_KEYS);
  assert.match(receipt.evidence_id, /^evidence-[a-f0-9]{24}$/);
  assert.equal(receipt.schema_version, '1.0');
  assert.equal(receipt.provider, 'cli-probe');
  assert.equal(receipt.tool_name, 'curl');
  assert.equal(receipt.capability, null);
  assert.equal(receipt.result_nonempty, true);
  assert.equal(receipt.failure, 'none');
  assert.equal(receipt.observed_at, '2026-07-23T05:00:00.000Z');
  assert.doesNotThrow(() => validateEvidenceReceipt(receipt));
});

test('raw tool args are never stored — only a hash and the sorted key names', () => {
  const receipt = createEvidenceContactReceipt(base);
  assert.equal('args' in receipt, false);
  assert.equal(JSON.stringify(receipt).includes('secret-xyz'), false);
  assert.match(receipt.args_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.arg_keys, ['token', 'url']);
});

test('references are the deterministic relevance basis: lowercased, deduped, sorted identifiers and counts', () => {
  const receipt = createEvidenceContactReceipt(base);
  assert.deepEqual(receipt.references, ['37/37', 'api', 'live', 'tests']);
});

test('capability is a pass-through label when provided', () => {
  const receipt = createEvidenceContactReceipt({ ...base, capability: 'runtime.test_run' });
  assert.equal(receipt.capability, 'runtime.test_run');
  assert.doesNotThrow(() => validateEvidenceReceipt(receipt));
});

test('contact-time failure is operational only: empty and error, never claim-relative', () => {
  const empty = createEvidenceContactReceipt({ ...base, result: { value: '', observed_at: '2026-07-23T05:00:00.000Z' } });
  assert.equal(empty.failure, 'empty');
  assert.equal(empty.result_nonempty, false);
  assert.deepEqual(empty.references, []);

  const errored = createEvidenceContactReceipt({ ...base, result: { error: 'connection refused' } });
  assert.equal(errored.failure, 'error');
  assert.equal(errored.result_nonempty, false);
  assert.equal(errored.observed_at, null);
});

test('a future observed_at is still a valid contact (freshness is decided at the link step, not here)', () => {
  const receipt = createEvidenceContactReceipt({ ...base, result: { value: 'api is live', observed_at: '2026-07-23T09:00:00.000Z' } });
  assert.equal(receipt.failure, 'none');
  assert.equal(receipt.observed_at, '2026-07-23T09:00:00.000Z');
  assert.doesNotThrow(() => validateEvidenceReceipt(receipt));
});

test('hashing is deterministic across object key order in args and result value', () => {
  const one = createEvidenceContactReceipt({
    ...base, toolCall: { provider: 'cli-probe', name: 'curl', args: { a: 1, b: 2 } },
    result: { value: { x: 1, y: 2 }, observed_at: '2026-07-23T05:00:00.000Z' },
  });
  const two = createEvidenceContactReceipt({
    ...base, toolCall: { provider: 'cli-probe', name: 'curl', args: { b: 2, a: 1 } },
    result: { value: { y: 2, x: 1 }, observed_at: '2026-07-23T05:00:00.000Z' },
  });
  assert.equal(one.args_sha256, two.args_sha256);
  assert.equal(one.result_hash, two.result_hash);
  assert.equal(one.evidence_id, two.evidence_id);
});

test('validateEvidenceReceipt detects post-creation tampering', () => {
  const receipt = createEvidenceContactReceipt(base);
  assert.throws(() => validateEvidenceReceipt({ ...receipt, session_id: 'sess-other' }), /identity mismatch/);
});

test('createEvidenceContactReceipt rejects malformed inputs', () => {
  assert.throws(() => createEvidenceContactReceipt({ ...base, session_id: '' }), /session_id must be a non-empty string/);
  assert.throws(() => createEvidenceContactReceipt({ ...base, toolCall: { provider: 'cli-probe', name: 'curl', args: [] } }), /toolCall is invalid/);
  assert.throws(() => createEvidenceContactReceipt({ ...base, result: [] }), /result is invalid/);
  assert.throws(() => createEvidenceContactReceipt({ ...base, capability: '' }), /capability must be null or a non-empty string/);
});

test('extractReferences handles strings, non-strings, dedupe, and empty', () => {
  assert.deepEqual(extractReferences('API api Api foo-bar 12/12 ok'), ['12/12', 'api', 'foo-bar']);
  assert.deepEqual(extractReferences({ service: 'lambda', count: 5 }), ['count', 'lambda', 'service']);
  assert.deepEqual(extractReferences(''), []);
  assert.deepEqual(extractReferences('a b c'), []);
  const many = extractReferences(Array.from({ length: 500 }, (_, i) => `sym${String(i).padStart(4, '0')}`).join(' '));
  assert.equal(many.length, 200);
});

test('appendEvidenceReceipt writes one validated JSONL row at mode 0600 without truncation', () => {
  const dir = fs.mkdtempSync('/tmp/leadline-evidence-');
  const file = path.join(dir, 'evidence.jsonl');
  const receipt = createEvidenceContactReceipt(base);
  appendEvidenceReceipt(file, receipt);
  appendEvidenceReceipt(file, receipt);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [receipt, receipt]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('appendEvidenceReceipt rejects invalid receipts', () => {
  const dir = fs.mkdtempSync('/tmp/leadline-evidence-invalid-');
  assert.throws(() => appendEvidenceReceipt(path.join(dir, 'evidence.jsonl'), { schema_version: '1.0' }), /invalid evidence receipt/);
});
