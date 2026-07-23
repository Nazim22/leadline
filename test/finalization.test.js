'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAuthorityPolicy, resolveAuthority } = require('../src/authority');
const { appendFinalizationReport, evaluateFinalization } = require('../src/finalization');
const { createEvidenceContactReceipt } = require('../src/evidence');

const policyPath = path.join(__dirname, '..', 'policy', 'authority.yaml');
const obligation = {
  claim_id: 'claim-abc123', candidate_id: 'runtime-live:0', claim: 'is live.',
  family: 'runtime', entity: 'api', confidence: 0.95, evidence: 'runtime probe',
};
const detectorResult = {
  status: 'ok', candidate_count: 1, obligations: [obligation], rejected: [],
  detector_fingerprint: 'claim-detector-abc', model_identity: 'ollama:qwen@digest',
};

function evidence({ provider = 'cli-probe', value = 'api is live', observed_at, name = 'curl', args = { url: '/health' }, now }) {
  return createEvidenceContactReceipt({
    session_id: 'sess-1', turn_id: 'turn-1', tool_call_id: `tc-${observed_at}`,
    toolCall: { provider, name, args }, result: { value, observed_at }, now,
  });
}

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
    completionId: 'turn-1', detectorResult, evidenceReceipts: [], policy: loadAuthorityPolicy(policyPath),
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.mode, 'shadow');
  assert.equal(report.action, 'log_only');
  assert.equal(report.summary.unsupported, 1);
  assert.equal(report.summary.supported, 0);
  assert.equal(report.summary.ambiguous, 0);
  assert.equal(report.obligations[0].status, 'unsupported');
  assert.equal(report.obligations[0].match_method, 'none');
  assert.equal(report.obligations[0].fresh_at_finalization, false);
  assert.deepEqual(report.obligations[0].matched_evidence_ids, []);
  assert.equal(report.obligations[0].override_provenance, null);
  assert.equal('block' in report, false);
});

test('shadow finalization links a fresh authoritative contact whose result references the claim entity', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const contact = evidence({ observed_at: '2026-07-23T05:08:00.000Z', now: new Date('2026-07-23T05:08:01.000Z') });
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, evidenceReceipts: [contact], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 1);
  assert.equal(report.summary.unsupported, 0);
  assert.equal(report.obligations[0].status, 'supported');
  assert.equal(report.obligations[0].match_method, 'entity_in_references');
  assert.equal(report.obligations[0].fresh_at_finalization, true);
  assert.deepEqual(report.obligations[0].matched_evidence_ids, [contact.evidence_id]);
});

test('a stale-only authoritative contact is ambiguous, and non-authoritative / off-entity contacts are ignored', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const stale = evidence({ observed_at: '2026-07-23T05:00:00.000Z', now: new Date('2026-07-23T05:00:01.000Z') });
  const wrongProvider = evidence({ provider: 'grep', name: 'read', observed_at: '2026-07-23T05:09:00.000Z', now: new Date('2026-07-23T05:09:01.000Z') });
  const offEntity = evidence({ value: 'database is live', observed_at: '2026-07-23T05:09:00.000Z', now: new Date('2026-07-23T05:09:01.000Z') });
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, evidenceReceipts: [stale, wrongProvider, offEntity], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 0);
  assert.equal(report.summary.unsupported, 0);
  assert.equal(report.summary.ambiguous, 1);
  assert.equal(report.obligations[0].status, 'ambiguous');
  assert.equal(report.obligations[0].match_method, 'entity_in_references');
  assert.equal(report.obligations[0].fresh_at_finalization, false);
  assert.deepEqual(report.obligations[0].matched_evidence_ids, []);
});

test('a future observed_at is not fresh at finalization (regression: future timestamps must not count as fresh)', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const future = evidence({ observed_at: '2026-07-23T06:10:00.000Z', now: new Date('2026-07-23T05:10:00.000Z') });
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, evidenceReceipts: [future], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.obligations[0].fresh_at_finalization, false);
  assert.equal(report.obligations[0].status, 'ambiguous');
  assert.equal(report.summary.supported, 0);
});

test('an override forces supported with logged provenance even when no contact satisfies', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const provenance = { actor: 'nazz', reason: 'manually verified out-of-band', at: '2026-07-23T05:09:30.000Z' };
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, evidenceReceipts: [], policy,
    overrides: { 'claim-abc123': provenance }, now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 1);
  assert.equal(report.summary.unsupported, 0);
  assert.equal(report.obligations[0].status, 'supported');
  assert.equal(report.obligations[0].match_method, 'override');
  assert.deepEqual(report.obligations[0].override_provenance, provenance);
});

test('detector operational failure is logged as degraded, not an unsupported claim', () => {
  const report = evaluateFinalization({
    completionId: 'turn-2',
    detectorResult: {
      status: 'unavailable', failure: 'llm_request_failed', candidate_count: 1,
      obligations: [], rejected: [], detector_fingerprint: 'claim-detector-abc', model_identity: 'ollama:qwen@digest',
    },
    evidenceReceipts: [], policy: loadAuthorityPolicy(policyPath), now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.detector_status, 'unavailable');
  assert.equal(report.summary.unsupported, 0);
  assert.equal(report.summary.not_evaluated, 1);
  assert.equal(report.action, 'log_only');
});

test('finalization reports append without truncation', () => {
  const report = evaluateFinalization({
    completionId: 'turn-1', detectorResult, evidenceReceipts: [], policy: loadAuthorityPolicy(policyPath),
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  const dir = fs.mkdtempSync('/tmp/leadline-finalization-');
  const file = path.join(dir, 'finalization.jsonl');
  appendFinalizationReport(file, report);
  appendFinalizationReport(file, report);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
