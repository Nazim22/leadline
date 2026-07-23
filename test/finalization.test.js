'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAuthorityPolicy, requiredCapabilities } = require('../src/authority');
const { appendFinalizationReport, evaluateFinalization } = require('../src/finalization');
const { createEvidenceContactReceipt } = require('../src/evidence');

const policyPath = path.join(__dirname, '..', 'policy', 'authority.yaml');

// A discriminative entity (generic tokens like 'api'/'lambda' never match the conservative matcher).
const ENTITY = 'cstoregenie-app';
const obligation = {
  claim_id: 'claim-abc123', candidate_id: 'runtime-live:0', pattern_id: 'runtime-live', claim: 'is live.',
  family: 'runtime', entity: ENTITY, confidence: 0.95, evidence: 'runtime probe',
};
const detectorResult = {
  status: 'ok', candidate_count: 1, obligations: [obligation], rejected: [],
  detector_fingerprint: 'claim-detector-abc', model_identity: 'ollama:qwen@digest',
};

// Capability is DERIVED from the tool call, so we pick a toolCall whose shape yields the wanted capability.
const TOOL_CALLS = {
  health: { provider: 'bash', name: 'bash', args: { command: 'curl https://svc/health' } }, // runtime.health_probe
  test: { provider: 'bash', name: 'bash', args: { command: 'npm test' } }, // runtime.test_run
  read: { provider: 'read', name: 'read', args: { file: 'src/x.js' } }, // repository.current_bytes
  gbrain: { provider: 'mcp__gbrain__query', name: 'query', args: { q: 'x' } }, // historical.decision_recall
  graph: { provider: 'mcp__graphify-cstore__query_graph', name: 'query_graph', args: { q: 'x' } }, // structural.complete_callers
};

function evidence({
  kind = 'health', value = `${ENTITY} is live`, observed_at, now,
  session_id = 'sess-1', turn_id = 'turn-1',
}) {
  return createEvidenceContactReceipt({
    session_id, turn_id, tool_call_id: `tc-${session_id}-${turn_id}-${kind}-${observed_at}`,
    toolCall: TOOL_CALLS[kind], result: { value, observed_at }, now,
  });
}

const SCOPE = { sessionId: 'sess-1', turnId: 'turn-1' };

test('authority policy is strict, shadow-only, and maps claim patterns to capabilities', () => {
  const policy = loadAuthorityPolicy(policyPath);
  assert.equal(policy.mode, 'shadow');
  assert.deepEqual(Object.keys(policy.families).sort(), ['historical', 'repository', 'runtime', 'structural']);
  assert.deepEqual(requiredCapabilities(policy, 'runtime-live'), ['runtime.health_probe']);
  assert.deepEqual(requiredCapabilities(policy, 'test-pass'), ['runtime.test_run']);
  assert.deepEqual(requiredCapabilities(policy, 'hist-decided'), ['historical.decision_recall']);
  assert.throws(() => requiredCapabilities(policy, 'unknown-pattern'), /unknown claim pattern/);
});

test('shadow finalization logs unsupported claims and never blocks', () => {
  const report = evaluateFinalization({
    completionId: 'turn-1', ...SCOPE, detectorResult, evidenceReceipts: [], policy: loadAuthorityPolicy(policyPath),
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
  assert.deepEqual(report.obligations[0].candidate_evidence_ids, []);
  assert.deepEqual(report.obligations[0].supporting_evidence_ids, []);
  assert.deepEqual(report.obligations[0].dispositions, []);
  assert.equal(report.obligations[0].override_provenance, null);
  assert.equal('block' in report, false);
});

test('finalization report records and hashes the enforced session/turn scope (Dae mandatory patch)', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const shared = { completionId: 'turn-1', detectorResult, evidenceReceipts: [], policy, now: new Date('2026-07-23T05:10:00.000Z') };
  const a = evaluateFinalization({ ...shared, sessionId: 'sess-1', turnId: 'turn-1' });
  const b = evaluateFinalization({ ...shared, sessionId: 'sess-1', turnId: 'turn-9' });
  assert.equal(a.session_id, 'sess-1');
  assert.equal(a.turn_id, 'turn-1');
  // scope participates in enforcement_id: changing turn changes the artifact identity
  assert.notEqual(a.enforcement_id, b.enforcement_id);
});

test('shadow finalization links a fresh authoritative contact whose result references the claim entity', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const contact = evidence({ observed_at: '2026-07-23T05:08:00.000Z', now: new Date('2026-07-23T05:08:01.000Z') });
  const report = evaluateFinalization({
    completionId: 'turn-1', ...SCOPE, detectorResult, evidenceReceipts: [contact], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 1);
  assert.equal(report.summary.unsupported, 0);
  assert.equal(report.obligations[0].status, 'supported');
  assert.equal(report.obligations[0].match_method, 'capability_match');
  assert.equal(report.obligations[0].fresh_at_finalization, true);
  assert.deepEqual(report.obligations[0].candidate_evidence_ids, [contact.evidence_id]);
  assert.deepEqual(report.obligations[0].supporting_evidence_ids, [contact.evidence_id]);
  const [disp] = report.obligations[0].dispositions;
  assert.equal(disp.evidence_id, contact.evidence_id);
  assert.equal(disp.decision, 'supporting');
  assert.equal(disp.match_explanation.method, 'atomic');
  assert.deepEqual(disp.match_explanation.matched_terms, [ENTITY]);
});

test('stale-only is ambiguous; wrong-capability and off-entity contacts are classified, not dropped', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const stale = evidence({ observed_at: '2026-07-23T05:00:00.000Z', now: new Date('2026-07-23T05:00:01.000Z') });
  const wrongCapability = evidence({ kind: 'read', observed_at: '2026-07-23T05:09:00.000Z', now: new Date('2026-07-23T05:09:01.000Z') });
  const offEntity = evidence({ value: 'database is live', observed_at: '2026-07-23T05:09:00.000Z', now: new Date('2026-07-23T05:09:01.000Z') });
  const report = evaluateFinalization({
    completionId: 'turn-1', ...SCOPE, detectorResult, evidenceReceipts: [stale, wrongCapability, offEntity], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 0);
  assert.equal(report.summary.unsupported, 0);
  assert.equal(report.summary.ambiguous, 1);
  assert.equal(report.obligations[0].status, 'ambiguous');
  assert.deepEqual(report.obligations[0].supporting_evidence_ids, []);
  const byId = Object.fromEntries(report.obligations[0].dispositions.map((item) => [item.evidence_id, item.decision]));
  // stale keeps its evidence_id (the audit gap Dae flagged); off-capability and off-entity are classified.
  assert.equal(byId[stale.evidence_id], 'stale');
  assert.equal(byId[wrongCapability.evidence_id], 'wrong_capability');
  assert.equal(byId[offEntity.evidence_id], 'entity_mismatch');
});

test('cross-session/turn evidence never supports a claim: out-of-scope receipts get wrong_scope (Item 1)', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const inScope = evidence({ observed_at: '2026-07-23T05:08:00.000Z', now: new Date('2026-07-23T05:08:01.000Z') });
  const crossScope = evidence({
    observed_at: '2026-07-23T05:08:00.000Z', now: new Date('2026-07-23T05:08:01.000Z'),
    session_id: 'sess-2', turn_id: 'turn-2',
  });
  const report = evaluateFinalization({
    completionId: 'turn-1', ...SCOPE, detectorResult, evidenceReceipts: [inScope, crossScope], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 1);
  assert.deepEqual(report.obligations[0].supporting_evidence_ids, [inScope.evidence_id]);
  const byId = Object.fromEntries(report.obligations[0].dispositions.map((item) => [item.evidence_id, item.decision]));
  assert.equal(byId[inScope.evidence_id], 'supporting');
  assert.equal(byId[crossScope.evidence_id], 'wrong_scope');
});

test('a receipt whose contact timestamp is in the future is corrupt input: future_timestamp, never supporting (Item 2)', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const futureContact = evidence({ observed_at: '2026-07-23T05:12:00.000Z', now: new Date('2026-07-23T05:12:00.000Z') });
  const report = evaluateFinalization({
    completionId: 'turn-1', ...SCOPE, detectorResult, evidenceReceipts: [futureContact], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 0);
  assert.deepEqual(report.obligations[0].supporting_evidence_ids, []);
  assert.equal(report.obligations[0].dispositions[0].decision, 'future_timestamp');
});

test('a historical/any-freshness claim with a future observed_at is not fresh and stays ambiguous (Item 2)', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const histObligation = { ...obligation, claim_id: 'claim-hist', candidate_id: 'hist-decided:0', pattern_id: 'hist-decided', family: 'historical', entity: 'neon' };
  const histDetector = { ...detectorResult, obligations: [histObligation] };
  const futureObserved = evidence({
    kind: 'gbrain', value: 'we chose neon', observed_at: '2026-07-23T06:00:00.000Z',
    now: new Date('2026-07-23T05:09:00.000Z'),
  });
  const report = evaluateFinalization({
    completionId: 'turn-1', ...SCOPE, detectorResult: histDetector, evidenceReceipts: [futureObserved], policy,
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.obligations[0].status, 'ambiguous');
  assert.deepEqual(report.obligations[0].supporting_evidence_ids, []);
  assert.equal(report.obligations[0].dispositions[0].decision, 'stale');
});

test('a future observed_at is not fresh at finalization (regression: future timestamps must not count as fresh)', () => {
  const policy = loadAuthorityPolicy(policyPath);
  const future = evidence({ observed_at: '2026-07-23T06:10:00.000Z', now: new Date('2026-07-23T05:10:00.000Z') });
  const report = evaluateFinalization({
    completionId: 'turn-1', ...SCOPE, detectorResult, evidenceReceipts: [future], policy,
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
    completionId: 'turn-1', ...SCOPE, detectorResult, evidenceReceipts: [], policy,
    overrides: { 'claim-abc123': provenance }, now: new Date('2026-07-23T05:10:00.000Z'),
  });
  assert.equal(report.summary.supported, 1);
  assert.equal(report.obligations[0].status, 'supported');
  assert.equal(report.obligations[0].match_method, 'override');
  assert.deepEqual(report.obligations[0].override_provenance, provenance);
});

test('detector operational failure is logged as degraded, not an unsupported claim', () => {
  const report = evaluateFinalization({
    completionId: 'turn-2', ...SCOPE,
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

test('finalization reports append without truncation at mode 0600', () => {
  const report = evaluateFinalization({
    completionId: 'turn-1', ...SCOPE, detectorResult, evidenceReceipts: [], policy: loadAuthorityPolicy(policyPath),
    now: new Date('2026-07-23T05:10:00.000Z'),
  });
  const dir = fs.mkdtempSync('/tmp/leadline-finalization-');
  const file = path.join(dir, 'finalization.jsonl');
  appendFinalizationReport(file, report);
  appendFinalizationReport(file, report);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
