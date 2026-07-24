'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPABILITY_MAP_VERSION, capabilityMapSha, deriveCapability,
} = require('../src/capability');
const { ENTITY_MATCHER_VERSION, entityMatcherSha } = require('../src/entity-match');
const { canonicalize, createEvidenceContactReceipt } = require('../src/evidence');
const { evaluateFinalization } = require('../src/finalization');
const { loadAuthorityPolicy } = require('../src/authority');

const ROOT = path.join(__dirname, '..');
const policy = loadAuthorityPolicy(path.join(ROOT, 'policy', 'authority.yaml'));
const NOW = new Date('2026-07-24T02:30:00.000Z');
const OBSERVED = '2026-07-24T02:29:00.000Z';
const SCOPE = { sessionId: 'sess-ll1', turnId: 'turn-ll1' };

function gitStyleBytesSha256(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha256').update(header).update(bytes).digest('hex');
}

function gitStyleSha256(file) {
  return gitStyleBytesSha256(fs.readFileSync(file));
}

function contact({
  id, command, provider = 'bash', name = 'bash', args, value = 'cstoregenie-app',
  exit_code, is_error, http_status, error, truncated,
}) {
  const result = { value, observed_at: OBSERVED };
  if (exit_code !== undefined) result.exit_code = exit_code;
  if (is_error !== undefined) result.is_error = is_error;
  if (http_status !== undefined) result.http_status = http_status;
  if (error !== undefined) result.error = error;
  if (truncated !== undefined) result.truncated = truncated;
  return createEvidenceContactReceipt({
    session_id: SCOPE.sessionId,
    turn_id: SCOPE.turnId,
    tool_call_id: id,
    toolCall: { provider, name, args: args || { command } },
    result,
    now: new Date('2026-07-24T02:29:01.000Z'),
  });
}

function reportFor(evidenceReceipts, { pattern_id = 'runtime-live', family = 'runtime', entity = 'cstoregenie-app' } = {}) {
  return evaluateFinalization({
    completionId: 'completion-ll1',
    ...SCOPE,
    detectorResult: {
      status: 'ok',
      candidate_count: 1,
      obligations: [{
        claim_id: 'claim-ll1', candidate_id: `${pattern_id}:0`, pattern_id,
        claim: 'positive assertion', family, entity, confidence: 0.99, evidence: 'required',
      }],
      rejected: [], detector_fingerprint: 'detector-ll1', model_identity: 'model@digest',
    },
    evidenceReceipts,
    policy,
    now: NOW,
  });
}

const bash = (command) => deriveCapability({ provider: 'bash', name: 'bash', args: { command } });

test('LL-1 C1: Bash capability comes from an executed allowlisted command, never command text', () => {
  assert.equal(bash('cat /health/x'), null);
  assert.equal(bash('echo curl'), null);
  assert.equal(bash('printf "npm test"'), null);
  assert.equal(bash('rm -rf tmp; curl https://svc/health'), null);
  assert.equal(bash('npm test || true'), null);
  assert.equal(bash('npm test; true'), null);
  assert.equal(bash('curl https://svc/health'), 'runtime.health_probe');
  assert.equal(bash('cd /srv/app && node --test'), 'runtime.test_run');
  assert.equal(bash('curl -X POST https://svc/health'), null);
  assert.equal(bash('curl --data x=1 https://svc/health'), null);
  assert.equal(bash('wget --post-data=x https://svc/health'), null);
  assert.equal(bash('node app.js --test'), null);
  assert.equal(bash('npm test --if-present'), null);
  for (const noRun of [
    'npm test -- --help',
    'pytest --collect-only',
    'jest --listTests',
    'go test -list .',
    'cargo test -- --list',
    'gradle test --dry-run',
  ]) assert.equal(bash(noRun), null, `${noRun} must not claim a test run`);
  assert.equal(bash("sed -n 'e id' src/app.js"), null);
  assert.equal(bash("sed -e 'w /tmp/authority-bypass' src/app.js"), null);
  assert.equal(bash('less -o /tmp/authority-bypass src/app.js'), null);
  assert.equal(bash('find . -fprint /tmp/authority-bypass'), null);
  assert.equal(bash('grep --help'), null);
  assert.equal(bash('git status --help'), null);
  assert.equal(bash('systemctl status --help'), null);
  assert.equal(bash('git diff --output=/tmp/authority-bypass'), null);
  assert.equal(bash('git diff --ext-diff'), null);
  assert.equal(bash('rg --pre sh needle src'), null);
  assert.equal(bash("PAGER='sh -c id' git log"), null);
  assert.equal(bash("SYSTEMD_PAGER='sh -c id' systemctl status app"), null);
  assert.equal(bash('env CI=true npm test'), null);
});

test('LL-1 W5: generic graph operations are null; only completeness-semantic operations are structural', () => {
  assert.equal(deriveCapability({
    provider: 'mcp__graphify-cstore__query_graph', name: 'query_graph', args: {},
  }), null);
  assert.equal(deriveCapability({
    provider: 'mcp__code-review-graph__get_impact_radius_tool', name: 'get_impact_radius_tool', args: {},
  }), 'structural.complete_callers');
  assert.equal(deriveCapability({
    provider: 'mcp__graphify-cstore__get_callers', name: 'get_callers', args: {},
  }), 'structural.complete_callers');
  assert.equal(deriveCapability({
    provider: 'mcp__graphify-cstore__query_graph', name: 'get_callers', args: {},
  }), null);
  assert.equal(deriveCapability({
    provider: 'mcp__graphify-cstore__get_callers', name: 'query_graph', args: {},
  }), null);
  assert.equal(deriveCapability({
    provider: 'mcp__gbrain__put_page', name: 'query', args: {},
  }), null);
});

test('LL-1 C2: the frozen normalizer separates host execution from capability-specific outcome', () => {
  const active = contact({ id: 'systemctl-active', command: 'systemctl is-active fleet-hub', exit_code: 0 });
  assert.equal(active.execution_status, 'success');
  assert.equal(active.execution_reason, 'exit_code_zero');
  assert.equal(active.outcome_verdict, 'positive');
  assert.equal(active.outcome_reason, 'probe_exit_zero');

  const inactive = contact({ id: 'systemctl-inactive', command: 'systemctl is-active fleet-hub', exit_code: 3 });
  assert.equal(inactive.execution_status, 'failure');
  assert.equal(inactive.outcome_verdict, 'negative');
  assert.equal(inactive.outcome_reason, 'probe_exit_nonzero');

  const pctStopped = contact({
    id: 'pct-stopped', command: 'pct status 134', exit_code: 0, value: 'status: stopped',
  });
  assert.equal(pctStopped.execution_status, 'success');
  assert.equal(pctStopped.outcome_verdict, 'negative');
  assert.equal(pctStopped.outcome_reason, 'pct_stopped');

  const healthy = contact({ id: 'curl-200', command: 'curl https://svc/health', exit_code: 0, http_status: 200 });
  assert.equal(healthy.execution_status, 'success');
  assert.equal(healthy.outcome_verdict, 'positive');
  assert.equal(healthy.outcome_reason, 'http_2xx');

  const unhealthy = contact({ id: 'curl-503', command: 'curl --fail https://svc/health', exit_code: 22, http_status: 503 });
  assert.equal(unhealthy.execution_status, 'failure');
  assert.equal(unhealthy.outcome_verdict, 'negative');
  assert.equal(unhealthy.outcome_reason, 'http_error_status');

  const unverifiedCurl = contact({ id: 'curl-no-status', command: 'curl https://svc/health', exit_code: 0 });
  assert.equal(unverifiedCurl.execution_status, 'success');
  assert.equal(unverifiedCurl.outcome_verdict, 'unknown');
  assert.equal(unverifiedCurl.outcome_reason, 'http_status_missing');

  const testsPass = contact({ id: 'test-pass', command: 'npm test', exit_code: 0 });
  const testsFail = contact({ id: 'test-fail', command: 'npm test', exit_code: 1 });
  const testsUnknown = contact({ id: 'test-unknown', command: 'npm test' });
  assert.deepEqual(
    [testsPass.outcome_verdict, testsFail.outcome_verdict, testsUnknown.outcome_verdict],
    ['positive', 'negative', 'unknown'],
  );

  const read = contact({
    id: 'read-success', provider: 'read', name: 'read', args: { file: 'src/app/index.js' },
    value: 'src/app/index.js exports handler', is_error: false,
  });
  assert.equal(read.execution_status, 'success');
  assert.equal(read.outcome_verdict, 'positive');

  const falseError = createEvidenceContactReceipt({
    session_id: 's', turn_id: 't', tool_call_id: 'read-false-error',
    toolCall: { provider: 'read', name: 'read', args: { file: 'src/x.js' } },
    result: { value: 'src/x.js', error: false, is_error: false }, now: new Date('2026-07-24T02:29:00.000Z'),
  });
  assert.equal(falseError.execution_status, 'success');
  assert.equal(falseError.outcome_verdict, 'positive');
  assert.equal(falseError.result_nonempty, true);

  const truncatedGraph = contact({
    id: 'graph-truncated', provider: 'mcp__graphify-cstore__get_callers', name: 'get_callers',
    args: { symbol: 'handler' }, value: 'handler caller', is_error: false, truncated: true,
  });
  assert.equal(truncatedGraph.execution_status, 'success');
  assert.equal(truncatedGraph.outcome_verdict, 'unknown');
  assert.equal(truncatedGraph.outcome_reason, 'structural_truncated');
});

test('LL-1 W4: capability, matcher, and normalizer fingerprints bind exact source blobs', () => {
  assert.equal(CAPABILITY_MAP_VERSION, 'cap-v0.2');
  assert.equal(ENTITY_MATCHER_VERSION, 'entmatch-v0.2');
  assert.equal(capabilityMapSha(), gitStyleSha256(path.join(ROOT, 'src', 'capability.js')));
  assert.equal(entityMatcherSha(), gitStyleSha256(path.join(ROOT, 'src', 'entity-match.js')));
  const capabilityBytes = fs.readFileSync(path.join(ROOT, 'src', 'capability.js'));
  const entityBytes = fs.readFileSync(path.join(ROOT, 'src', 'entity-match.js'));
  assert.notEqual(capabilityMapSha(), gitStyleBytesSha256(Buffer.concat([capabilityBytes, Buffer.from('\n// changed rule')])));
  assert.notEqual(entityMatcherSha(), gitStyleBytesSha256(Buffer.concat([entityBytes, Buffer.from('\n// changed regex')])));
  const receipt = contact({ id: 'fingerprint', command: 'npm test', exit_code: 0 });
  assert.equal(receipt.normalizer_version, 'contact-normalizer-v0.2');
  assert.equal(receipt.normalizer_blob_sha256, capabilityMapSha());
  assert.match(receipt.normalizer_blob_sha256, /^[a-f0-9]{64}$/u);
  const report = reportFor([]);
  assert.equal(report.authority_policy_version, 'authority-v0.3');
  assert.equal(report.authority_policy_sha256, crypto.createHash('sha256').update(canonicalize(policy)).digest('hex'));
  assert.equal(report.capability_map_version, CAPABILITY_MAP_VERSION);
  assert.equal(report.capability_map_blob_sha256, capabilityMapSha());
  assert.equal(report.entity_matcher_version, ENTITY_MATCHER_VERSION);
  assert.equal(report.entity_matcher_blob_sha256, entityMatcherSha());
});

test('LL-1 C3: extractor and matcher share one grammar end-to-end for paths, scopes, and 2-char tokens', () => {
  const cases = [
    ['path', 'src/app/index.js', 'current bytes for src/app/index.js'],
    ['scope', '@scope/private', 'current bytes for @scope/private'],
    ['short', 'db migration', 'current db migration configuration'],
  ];
  for (const [id, entity, value] of cases) {
    const read = contact({
      id, provider: 'read', name: 'read', args: { file: entity }, value, is_error: false,
    });
    const report = reportFor([read], { pattern_id: 'repo-state', family: 'repository', entity });
    assert.equal(report.obligations[0].status, 'supported', `${entity} should match end-to-end`);
    assert.deepEqual(report.obligations[0].supporting_evidence_ids, [read.evidence_id]);
  }
});

test('LL-1 lattice: negative evidence contradicts, and unknown outcome stays unsupported', () => {
  const failedProbe = contact({
    id: 'failed-probe', command: 'curl --fail https://svc/health', exit_code: 7,
    value: 'connection refused for cstoregenie-app',
  });
  const contradicted = reportFor([failedProbe]);
  assert.equal(contradicted.obligations[0].status, 'contradicted');
  assert.deepEqual(contradicted.obligations[0].supporting_evidence_ids, []);
  assert.deepEqual(contradicted.obligations[0].contradicting_evidence_ids, [failedProbe.evidence_id]);
  assert.equal(contradicted.obligations[0].dispositions[0].decision, 'contradicting');
  assert.equal(contradicted.summary.contradicted, 1);

  const unknown = contact({
    id: 'unknown-probe', command: 'curl https://svc/health', exit_code: 0,
    value: 'cstoregenie-app response body without status',
  });
  const unsupported = reportFor([unknown]);
  assert.equal(unsupported.obligations[0].status, 'unsupported');
  assert.deepEqual(unsupported.obligations[0].supporting_evidence_ids, []);
  assert.deepEqual(unsupported.obligations[0].contradicting_evidence_ids, []);
  assert.equal(unsupported.obligations[0].dispositions[0].decision, 'outcome_unknown');
});

test('LL-1 lattice: simultaneous fresh positive and negative evidence is conflicted', () => {
  const positive = contact({
    id: 'positive', command: 'curl https://svc/health', exit_code: 0, http_status: 200,
    value: 'cstoregenie-app healthy',
  });
  const negative = contact({
    id: 'negative', command: 'curl --fail https://svc/health', exit_code: 22, http_status: 503,
    value: 'cstoregenie-app unavailable',
  });
  const report = reportFor([positive, negative]);
  assert.equal(report.obligations[0].status, 'conflicted');
  assert.deepEqual(report.obligations[0].supporting_evidence_ids, [positive.evidence_id]);
  assert.deepEqual(report.obligations[0].contradicting_evidence_ids, [negative.evidence_id]);
  assert.equal(report.summary.conflicted, 1);
  assert.equal(report.summary.supported, 0);
});

test('LL-1 fail-closed lattice: failed reads and stale unknowns do not manufacture contradiction or ambiguity', () => {
  const failedRead = contact({
    id: 'failed-read', provider: 'read', name: 'read', args: { file: 'src/app/index.js' },
    value: 'src/app/index.js permission denied', is_error: true,
  });
  const failedReport = reportFor([failedRead], {
    pattern_id: 'repo-state', family: 'repository', entity: 'src/app/index.js',
  });
  assert.equal(failedRead.outcome_verdict, 'unknown');
  assert.equal(failedReport.obligations[0].status, 'unsupported');
  assert.deepEqual(failedReport.obligations[0].contradicting_evidence_ids, []);
  assert.equal(failedReport.obligations[0].dispositions[0].decision, 'execution_failed');

  const staleUnknown = createEvidenceContactReceipt({
    session_id: SCOPE.sessionId, turn_id: SCOPE.turnId, tool_call_id: 'stale-unknown',
    toolCall: { provider: 'bash', name: 'bash', args: { command: 'curl https://svc/health' } },
    result: { value: 'cstoregenie-app response', exit_code: 0, observed_at: '2026-07-24T02:00:00.000Z' },
    now: new Date('2026-07-24T02:00:01.000Z'),
  });
  const staleUnknownReport = reportFor([staleUnknown]);
  assert.equal(staleUnknownReport.obligations[0].status, 'unsupported');
  assert.equal(staleUnknownReport.obligations[0].dispositions[0].decision, 'outcome_unknown');
});
