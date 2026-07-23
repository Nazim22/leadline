'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020');
const { appendReceipt, createClaimSupportReceipt, validateReceipt } = require('../src/receipts');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'use-receipt.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
ajv.addFormat('date-time', { type: 'string', validate: (value) => Number.isFinite(Date.parse(value)) });
const validate = ajv.compile(schema);

const obligation = {
  claim_id: 'claim-abc123',
  candidate_id: 'runtime-live:0',
  claim: 'is live and responding.',
  family: 'runtime',
  entity: 'cstoregenie-app lambda',
  confidence: 0.96,
  evidence: 'runtime probe',
};
const authority = {
  source: 'cli-probe',
  authoritative_sources: ['cli-probe'],
  authority_tier: 1,
  freshness: { requirement: 'fresh', max_age_seconds: 300 },
};

test('claim-support receipt captures authoritative fresh relevant evidence', () => {
  const receipt = createClaimSupportReceipt({
    obligation,
    authority,
    toolCall: { provider: 'cli-probe', name: 'curl', args: { url: 'https://example/health' } },
    result: { value: { status: 'ok' }, observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true, matched_terms: ['cstoregenie-app'] },
    now: new Date('2026-07-23T05:01:00.000Z'),
  });

  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  assert.match(receipt.receipt_id, /^receipt-[a-f0-9]{24}$/);
  assert.equal(receipt.claim_id, obligation.claim_id);
  assert.equal(receipt.source, 'cli-probe');
  assert.equal(receipt.authority_tier, 1);
  assert.equal(receipt.result_hash.length, 64);
  assert.equal(receipt.entity_matched, true);
  assert.equal(receipt.relevance.relevant, true);
  assert.equal(receipt.freshness.ok, true);
  assert.equal(receipt.policy_decision, 'satisfied');
  assert.equal(receipt.failure, 'none');
});

test('receipt fails closed for wrong source, empty, irrelevant, stale, and errors', () => {
  const cases = [
    [{ provider: 'grep', name: 'read', args: {} }, { value: 'ok', observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true }, 'wrong_source'],
    [{ provider: 'cli-probe', name: 'curl', args: {} }, { value: '', observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true }, 'empty'],
    [{ provider: 'cli-probe', name: 'curl', args: {} }, { value: 'ok', observed_at: '2026-07-23T05:00:00.000Z', entity_matched: false }, 'irrelevant'],
    [{ provider: 'cli-probe', name: 'curl', args: {} }, { value: 'ok', observed_at: '2026-07-23T04:00:00.000Z', entity_matched: true }, 'stale'],
    [{ provider: 'cli-probe', name: 'curl', args: {} }, { error: 'connection refused', observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true }, 'error'],
  ];
  for (const [toolCall, result, failure] of cases) {
    const receipt = createClaimSupportReceipt({ obligation, authority, toolCall, result, now: new Date('2026-07-23T05:10:00.000Z') });
    assert.equal(receipt.source, toolCall.provider);
    assert.equal(receipt.authority_tier, failure === 'wrong_source' ? null : 1);
    assert.equal(receipt.policy_decision, 'unsatisfied');
    assert.equal(receipt.failure, failure);
    assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  }
});

test('receipt hashing is deterministic across object key order', () => {
  const base = {
    obligation,
    authority,
    toolCall: { provider: 'cli-probe', name: 'curl', args: { a: 1, b: 2 } },
    result: { value: { x: 1, y: 2 }, observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true },
    now: new Date('2026-07-23T05:01:00.000Z'),
  };
  const one = createClaimSupportReceipt(base);
  const two = createClaimSupportReceipt({
    ...base,
    toolCall: { provider: 'cli-probe', name: 'curl', args: { b: 2, a: 1 } },
    result: { value: { y: 2, x: 1 }, observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true },
  });
  assert.equal(one.result_hash, two.result_hash);
  assert.equal(one.receipt_id, two.receipt_id);
});

test('appendReceipt writes one validated JSONL row without truncating prior receipts', () => {
  const dir = fs.mkdtempSync('/tmp/leadline-receipts-');
  const file = path.join(dir, 'receipts.jsonl');
  const receipt = createClaimSupportReceipt({
    obligation,
    authority,
    toolCall: { provider: 'cli-probe', name: 'curl', args: {} },
    result: { value: 'ok', observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true },
    now: new Date('2026-07-23T05:01:00.000Z'),
  });
  appendReceipt(file, receipt);
  appendReceipt(file, receipt);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [receipt, receipt]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('receipt identity detects post-creation tampering', () => {
  const receipt = createClaimSupportReceipt({
    obligation,
    authority,
    toolCall: { provider: 'cli-probe', name: 'curl', args: {} },
    result: { value: 'ok', observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true },
    now: new Date('2026-07-23T05:01:00.000Z'),
  });
  assert.throws(() => validateReceipt({ ...receipt, claim_id: 'claim-tampered' }), /identity mismatch/);
});

test('appendReceipt rejects invalid receipts', () => {
  const dir = fs.mkdtempSync('/tmp/leadline-receipts-invalid-');
  assert.throws(() => appendReceipt(path.join(dir, 'receipts.jsonl'), { schema_version: '1.0' }), /invalid receipt/);
});
