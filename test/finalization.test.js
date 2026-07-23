'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAuthorityPolicy, resolveAuthority } = require('../src/authority');
const { appendFinalizationReport, evaluateFinalization } = require('../src/finalization');
const { createClaimSupportReceipt } = require('../src/receipts');

const policyPath = path.join(__dirname, '..', 'policy', 'authority.yaml');
const obligation = {
  claim_id: 'claim-abc123', candidate_id: 'runtime-live:0', claim: 'is live.',
  family: 'runtime', entity: 'api', confidence: 0.95, evidence: 'runtime probe',
};
const detectorResult = {
  status: 'ok', candidate_count: 1, obligations: [obligation], rejected: [],
  detector_fingerprint: 'claim-detector-abc', model_identity: 'ollama:qwen@digest',
};

test('authority policy is strict, shadow-only, and resolves allowed sources', () => {
  const policy = loadAuthorityPolicy(policyPath);
  assert.equal(policy.mode, 'shadow');
  assert.deepEqual(Object.keys(policy.families).sort(), ['historical', 'repository', 'runtime', 'structural']);
  assert.equal(resolveAuthority(policy, 'runtime', 'cli-probe').source, 'cli-probe');
  assert.equal(resolveAuthority(policy, 'runtime', 'grep').source, 'cli-probe');
  assert.throws(() => resolveAuthority(policy, 'unknown', 'grep'), /unknown claim family/);
});

test('shadow finalization logs unsupported claims and never blocks', () => {
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, receipts: [], policy: loadAuthorityPolicy(policyPath),
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.mode, 'shadow');
  assert.equal(report.action, 'log_only');
  assert.equal(report.summary.unsupported, 1);
  assert.equal(report.summary.supported, 0);
  assert.equal(report.obligations[0].status, 'unsupported');
  assert.equal(report.obligations[0].reason, 'no_satisfying_receipt');
  assert.equal('block' in report, false);
});

test('shadow finalization matches a fresh satisfying receipt by claim linkage', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const authority = resolveAuthority(policy, 'runtime', 'cli-probe');
  const receipt = createClaimSupportReceipt({
    obligation, authority,
    toolCall: { provider: 'cli-probe', name: 'curl', args: { url: '/health' } },
    result: { value: 'ok', observed_at: '2026-07-23T05:08:00.000Z', entity_matched: true, matched_terms: ['api'] },
    now: new Date('2026-07-23T05:08:01.000Z'),
  });
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, receipts: [receipt], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 1);
  assert.equal(report.summary.unsupported, 0);
  assert.equal(report.obligations[0].status, 'supported');
  assert.deepEqual(report.obligations[0].matched_receipt_ids, [receipt.receipt_id]);
});

test('shadow finalization rejects stale-at-stop and unrelated receipts', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const authority = resolveAuthority(policy, 'runtime', 'cli-probe');
  const old = createClaimSupportReceipt({
    obligation, authority,
    toolCall: { provider: 'cli-probe', name: 'curl', args: {} },
    result: { value: 'ok', observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true },
    now: new Date('2026-07-23T05:00:01.000Z'),
  });
  const unrelated = createClaimSupportReceipt({
    obligation: { ...obligation, claim_id: 'claim-other' }, authority,
    toolCall: { provider: 'cli-probe', name: 'curl', args: {} },
    result: { value: 'ok', observed_at: '2026-07-23T05:00:00.000Z', entity_matched: true },
    now: new Date('2026-07-23T05:00:01.000Z'),
  });
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, receipts: [old, unrelated], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.unsupported, 1);
  assert.equal(report.obligations[0].reason, 'receipt_stale_at_finalization');
});

test('detector operational failure is logged as degraded, not an unsupported claim', () => {
  const report = evaluateFinalization({
    completionId: 'turn-2',
    detectorResult: {
      status: 'unavailable', failure: 'llm_request_failed', candidate_count: 1,
      obligations: [], rejected: [], detector_fingerprint: 'claim-detector-abc', model_identity: 'ollama:qwen@digest',
    },
    receipts: [], policy: loadAuthorityPolicy(policyPath), now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.detector_status, 'unavailable');
  assert.equal(report.summary.unsupported, 0);
  assert.equal(report.summary.not_evaluated, 1);
  assert.equal(report.action, 'log_only');
});

test('finalization reports append without truncation', () => {
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, receipts: [], policy: loadAuthorityPolicy(policyPath),
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  const dir = fs.mkdtempSync('/tmp/leadline-finalization-');
  const file = path.join(dir, 'finalization.jsonl');
  appendFinalizationReport(file, report);
  appendFinalizationReport(file, report);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
