'use strict';

// Tests for the active receipt path (appendReceipt / validateReceipt).
// The superseded createClaimSupportReceipt helper was removed (dead in the new path);
// these tests exercise the surviving surface without depending on it.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { appendReceipt, validateReceipt, hashValue } = require('../src/receipts');

// Build a fully schema-valid receipt by deriving its id from the canonical core hash.
function buildReceipt(overrides = {}) {
  const core = {
    schema_version: '1.0',
    claim_id: 'claim-abc123',
    obligation_id: 'runtime-live:0',
    claim: 'is live and responding.',
    family: 'runtime',
    entity: 'cstoregenie-app lambda',
    source: 'cli-probe',
    authority_tier: 1,
    tool: { provider: 'cli-probe', name: 'curl', args: { url: 'https://example/health' } },
    timestamp: '2026-07-23T05:01:00.000Z',
    freshness: { requirement: 'fresh', max_age_seconds: 300, observed_at: '2026-07-23T05:00:00.000Z', age_seconds: 60, ok: true },
    result_hash: 'a'.repeat(64),
    result_nonempty: true,
    entity_matched: true,
    relevance: { relevant: true, method: 'adapter_asserted_v0', matched_terms: ['cstoregenie-app'] },
    policy_decision: 'satisfied',
    failure: 'none',
    override_provenance: null,
    ...overrides,
  };
  const { receipt_id: _omit, ...coreOnly } = core;
  return { ...core, receipt_id: `receipt-${hashValue(coreOnly).slice(0, 24)}` };
}

test('appendReceipt writes one validated JSONL row without truncating prior receipts', () => {
  const dir = fs.mkdtempSync('/tmp/leadline-receipts-');
  const file = path.join(dir, 'receipts.jsonl');
  const receipt = buildReceipt();
  assert.doesNotThrow(() => appendReceipt(file, receipt));
  appendReceipt(file, receipt);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [receipt, receipt]);
  assert.ok((fs.statSync(file).mode & 0o777) >= 0o600, 'receipt file should be owner-restricted');
});

test('appendReceipt rejects invalid receipts', () => {
  const dir = fs.mkdtempSync('/tmp/leadline-receipts-invalid-');
  assert.throws(() => appendReceipt(path.join(dir, 'receipts.jsonl'), { schema_version: '1.0' }), /invalid receipt/);
});

test('validateReceipt accepts a well-formed receipt', () => {
  assert.doesNotThrow(() => validateReceipt(buildReceipt()));
});

test('validateReceipt rejects a tampered receipt_id', () => {
  const receipt = buildReceipt();
  const tampered = { ...receipt, claim_id: 'claim-tampered' };
  assert.throws(() => validateReceipt(tampered), /identity mismatch/);
});
