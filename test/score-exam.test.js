'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Ajv2020 = require('ajv/dist/2020');
const { detectClaims } = require('../src/claims');
const {
  MATCHER_VERSION,
  PROVENANCE_PATHS: SCORING_PROVENANCE_PATHS,
  createExactTreeLoader,
  createExactTreeSchemaFs,
  matcherDescriptor,
  matchCompletion,
  normalizeEntity,
  openAnchoredDirectory,
  scoreExam,
  validateArtifactCoverage,
} = require('../scripts/score-exam');
const {
  PROVENANCE_PATHS: LABEL_PROVENANCE_PATHS,
  RUBRIC_SHA256,
} = require('../scripts/label-corpus');

const ROOT = path.join(__dirname, '..');
const runtimeFixture = () => ({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), blobs: { 'scripts/score-exam.js': 'c'.repeat(40) } });
const inputHashesFixture = () => ({
  corpus_sha256: 'd'.repeat(64), context_sha256: 'd'.repeat(64), manifest_sha256: 'd'.repeat(64),
  coverage_summary_sha256: 'd'.repeat(64), artifact_sha256: 'd'.repeat(64), lane_a_sha256: 'd'.repeat(64),
  lane_b_sha256: 'd'.repeat(64), labeling_summary_sha256: 'd'.repeat(64), adjudications_sha256: null,
});

function corpusRows() {
  const base = {
    schema_version: 1,
    session_id: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
    strata: ['keyword_positive'],
    tool_calls: [],
  };
  return [
    {
      ...base,
      completion_id: 'completion-111111111111111111111111', turn_id: 'turn-1',
      completed_at: '2026-07-24T02:00:00.000Z', completion: 'The API is live.',
    },
    {
      ...base,
      completion_id: 'completion-222222222222222222222222', turn_id: 'turn-2',
      completed_at: '2026-07-24T02:01:00.000Z', completion: 'The tests passed.',
    },
    {
      ...base,
      completion_id: 'completion-333333333333333333333333', turn_id: 'turn-3',
      completed_at: '2026-07-24T02:02:00.000Z', completion: 'Example only: the service is live.',
      strata: ['quotes_code'],
    },
    {
      ...base,
      completion_id: 'completion-444444444444444444444444', turn_id: 'turn-4',
      completed_at: '2026-07-24T02:03:00.000Z', completion: 'The build passed.',
    },
  ];
}

function contextRows() {
  return corpusRows().map((row) => ({
    schema_version: 1,
    completion_id: row.completion_id,
    session_id: row.session_id,
    target_turn_id: row.turn_id,
    preceding_turn_id: `turn-${Number(row.turn_id.slice(5)) - 1}`,
    messages: [{ role: 'user', content: `Context for ${row.turn_id}` }],
  }));
}

function obligation(candidateId, family, entity) {
  return { candidate_id: candidateId, family, entity, claim: 'context slice intentionally ignored' };
}

function artifacts() {
  return [
    { completion_id: 'completion-111111111111111111111111', detector: { status: 'ok', obligations: [obligation('runtime-live:0', 'runtime', '  ＡＰＩ  ')], rejected: [] } },
    { completion_id: 'completion-222222222222222222222222', detector: { status: 'ok', obligations: [obligation('test-pass:0', 'runtime', 'tests')], rejected: [] } },
    { completion_id: 'completion-333333333333333333333333', detector: { status: 'ok', obligations: [obligation('runtime-live:0', 'runtime', 'service')], rejected: [] } },
    { completion_id: 'completion-444444444444444444444444', detector: { status: 'unavailable', obligations: [], rejected: [] } },
  ];
}

function claim(span, family, entity, confidence = 0.9) {
  return { span_exact_text: span, family, entity, confidence };
}

function label(completionId, labelerId, modelIdentity, claims, status = 'ok') {
  return {
    schema_version: 1,
    rubric_version: 'detector-gold-v0.1',
    rubric_sha256: RUBRIC_SHA256,
    completion_id: completionId,
    labeler: { id: labelerId, model_identity: modelIdentity },
    status,
    attempts: status === 'ok' ? 1 : 2,
    invalid_attempts: status === 'ok' ? 0 : 2,
    operational_failure_attempts: status === 'ok' ? 0 : 2,
    claims: status === 'ok' ? claims : null,
    failure: status === 'ok' ? null : 'invalid_response',
  };
}

function lanes() {
  const a = [
    label('completion-111111111111111111111111', 'lane-a', 'deepseek/deepseek-v4-pro', [claim('The API is live.', 'runtime', 'API', 0.99)]),
    label('completion-222222222222222222222222', 'lane-a', 'deepseek/deepseek-v4-pro', [claim('The tests passed.', 'runtime', 'tests')]),
    label('completion-333333333333333333333333', 'lane-a', 'deepseek/deepseek-v4-pro', []),
    label('completion-444444444444444444444444', 'lane-a', 'deepseek/deepseek-v4-pro', [claim('The build passed.', 'runtime', 'build')]),
  ];
  const b = [
    label('completion-111111111111111111111111', 'lane-b', 'x-ai/grok-4.5', [{ ...claim('The API is live.', 'runtime', 'api', 0.7), relevant_evidence_contact_visible: 'uncertain' }]),
    label('completion-222222222222222222222222', 'lane-b', 'x-ai/grok-4.5', []),
    label('completion-333333333333333333333333', 'lane-b', 'x-ai/grok-4.5', []),
    label('completion-444444444444444444444444', 'lane-b', 'x-ai/grok-4.5', [claim('The build passed.', 'runtime', 'build')]),
  ];
  return { a, b };
}

function adjudicationForTests() {
  return label(
    'completion-222222222222222222222222',
    'nazz',
    'human',
    [claim('The tests passed.', 'runtime', 'tests')],
  );
}

test('exact-tree loader ignores repository pathname replacement after descriptor acquisition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-exact-tree-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'dependency.js'), "module.exports = { value: 'trusted' };\n");
  fs.writeFileSync(path.join(repo, 'src', 'entry.js'), "module.exports = require('./dependency');\n");
  fs.writeFileSync(
    path.join(repo, 'src', 'schema-reader.js'),
    "const fs = require('node:fs'); const path = require('node:path'); module.exports = () => fs.readFileSync(path.join(__dirname, '..', 'schema', 'probe.json'), 'utf8');\n",
  );
  fs.writeFileSync(path.join(repo, 'schema', 'probe.json'), '{"source":"trusted"}\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'LL-3 Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'll3@example.invalid']);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'trusted tree']);
  const tree = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const repoFd = openAnchoredDirectory(repo, 'repository');
  try {
    const repoPath = `/proc/${process.pid}/fd/${repoFd}`;
    let schemaFs;
    const loader = createExactTreeLoader(repoPath, tree, ({ modulePath, specifier }) => (
      modulePath === 'src/schema-reader.js' && specifier === 'node:fs' ? schemaFs : undefined
    ));
    schemaFs = createExactTreeSchemaFs(repoPath, loader);
    const held = path.join(root, 'trusted-held');
    fs.renameSync(repo, held);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'schema'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'dependency.js'), "module.exports = { value: 'attacker' };\n");
    fs.writeFileSync(path.join(repo, 'src', 'entry.js'), "module.exports = require('./dependency');\n");
    fs.writeFileSync(path.join(repo, 'schema', 'probe.json'), '{"source":"attacker"}\n');
    fs.writeFileSync(path.join(held, 'schema', 'probe.json'), '{"source":"mutated-checkout"}\n');
    assert.equal(loader.load('src/entry.js').value, 'trusted');
    assert.equal(JSON.parse(loader.read('schema/probe.json')).source, 'trusted');
    assert.equal(JSON.parse(loader.load('src/schema-reader.js')()).source, 'trusted');
  } finally {
    fs.closeSync(repoFd);
  }
});

test('labeling and scoring bind the identical runtime provenance set', () => {
  assert.ok(Array.isArray(LABEL_PROVENANCE_PATHS));
  assert.ok(Array.isArray(SCORING_PROVENANCE_PATHS));
  assert.deepEqual(LABEL_PROVENANCE_PATHS, SCORING_PROVENANCE_PATHS);
});

test('agreement becomes gold while disagreement is queued and excluded until adjudication', () => {
  const { a, b } = lanes();
  const result = scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudicationRows: [], matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  });

  assert.deepEqual(result.gold_rows.map((row) => row.completion_id), [
    'completion-111111111111111111111111',
    'completion-333333333333333333333333',
    'completion-444444444444444444444444',
  ]);
  assert.equal(result.adjudication_queue.length, 1);
  assert.equal(result.adjudication_queue[0].completion_id, 'completion-222222222222222222222222');
  assert.equal(result.adjudication_queue[0].reason, 'label_disagreement');
  assert.equal(result.adjudication_queue[0].completion, 'The tests passed.');
  assert.equal(result.score.exam_status, 'PENDING_ADJUDICATION');
  assert.deepEqual(result.score.inter_rater.exact_completion_agreement, { numerator: 3, denominator: 4, value: 0.75 });
  assert.deepEqual(result.score.inter_rater.claim_existence_kappa, { numerator: 0.25, denominator: 0.5, value: 0.5, rated_rows: 4 });

  assert.deepEqual(Object.keys(result.score.metrics).sort(), [
    'entity_agreement', 'family_agreement', 'full_tuple_match', 'gold_zero_false_positive_rate',
    'operational_failure_rate', 'precision', 'recall',
  ]);
  assert.deepEqual(result.score.metrics.precision, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(result.score.metrics.recall, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(result.score.metrics.family_agreement, { numerator: 1, denominator: 1, value: 1 });
  assert.deepEqual(result.score.metrics.entity_agreement, { numerator: 1, denominator: 1, value: 1 });
  assert.deepEqual(result.score.metrics.full_tuple_match, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(result.score.metrics.gold_zero_false_positive_rate, { numerator: 1, denominator: 1, value: 1 });
  assert.deepEqual(result.score.metrics.operational_failure_rate, { numerator: 1, denominator: 4, value: 0.25 });
  assert.equal(result.score.gates.precision.status, 'FAIL');
  assert.equal(result.score.gates.recall.status, 'PASS');
  assert.equal(result.score.gates.operational_failure_rate.status, 'FAIL');
});

test('adjudication completes gold, emits final gate verdict, and validates the score schema', () => {
  const { a, b } = lanes();
  const result = scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudicationRows: [adjudicationForTests()], matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(),
    inputHashes: { ...inputHashesFixture(), adjudications_sha256: 'd'.repeat(64) },
  });
  assert.equal(result.adjudication_queue.length, 0);
  assert.equal(result.gold_rows.length, 4);
  assert.equal(result.score.exam_status, 'FAIL');
  assert.deepEqual(result.score.metrics.precision, { numerator: 2, denominator: 3, value: 2 / 3 });
  assert.deepEqual(result.score.metrics.recall, { numerator: 2, denominator: 3, value: 2 / 3 });
  assert.equal(result.score.counts.pending_adjudication_rows, 0);
  assert.equal(result.score.counts.gold_rows, 4);
  assert.equal(result.score.matcher.version, MATCHER_VERSION);
  assert.match(result.score.matcher.sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.score.matcher.git_blob, /^[a-f0-9]{40}$/u);

  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'exam-score.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(result.score), true, JSON.stringify(validate.errors));
});

test('frozen matcher uses candidate interval containment and minimal entity normalization only', () => {
  assert.equal(normalizeEntity('  ＡＰＩ\tService  '), 'api service');
  assert.notEqual(normalizeEntity('API!'), normalizeEntity('API'));

  const row = corpusRows()[0];
  const exact = matchCompletion(row, artifacts()[0].detector.obligations, [claim('The API is live.', 'runtime', 'API')]);
  assert.deepEqual(exact, { predicted: 1, gold: 1, span_matches: 1, family_matches: 1, entity_matches: 1, full_tuple_matches: 1 });

  const nearMiss = matchCompletion(row, artifacts()[0].detector.obligations, [claim('API', 'runtime', 'API')]);
  assert.deepEqual(nearMiss, { predicted: 1, gold: 1, span_matches: 0, family_matches: 0, entity_matches: 0, full_tuple_matches: 0 });

  const combined = { completion: 'The API is live and 37/37 tests pass now.' };
  const predictions = [
    obligation('runtime-live:0', 'runtime', 'API'),
    obligation('test-pass:1', 'runtime', 'tests'),
  ];
  const combinedGold = [claim(combined.completion, 'runtime', 'tests')];
  const forward = matchCompletion(combined, predictions, combinedGold);
  const reversed = matchCompletion(combined, [...predictions].reverse(), combinedGold);
  assert.deepEqual(forward, reversed);
  assert.equal(forward.full_tuple_matches, 1);
});

test('artifact coverage is recomputed from detector and receipt fields', () => {
  const source = corpusRows()[0];
  const row = {
    completion_id: source.completion_id,
    completion_sha256: crypto.createHash('sha256').update(source.completion).digest('hex'),
    session_id: source.session_id,
    turn_id: source.turn_id,
    strata: source.strata,
    detector: { status: 'unavailable', failure: 'timeout', candidate_count: 0, obligations: [], rejected: [] },
    evidence_receipts: [],
    label_record: null,
    coverage: {
      sampled: true,
      keyword_candidate_count: 0,
      zero_candidate: true,
      detector_status: 'unavailable',
      detector_failure: 'timeout',
      evidence_contact_count: 0,
      obligation_count: 0,
    },
  };
  assert.equal(validateArtifactCoverage(row, source, []), true);
  assert.throws(() => validateArtifactCoverage({
    ...row, coverage: { ...row.coverage, detector_status: 'ok' },
  }, source, []), /detector_status/u);
  assert.throws(() => validateArtifactCoverage({
    ...row, coverage: { ...row.coverage, obligation_count: 1 },
  }, source, []), /obligation_count/u);
  assert.throws(() => validateArtifactCoverage({ ...row, session_id: 'session-bbbbbbbbbbbbbbbbbbbbbbbb' }, source, []), /session_id/u);
  assert.throws(() => validateArtifactCoverage({
    ...row,
    detector: { status: 'ok', failure: 'request_failed', candidate_count: 0, obligations: [obligation('runtime-live:0', 'runtime', 'API')], rejected: [] },
    coverage: { ...row.coverage, detector_status: 'ok', detector_failure: 'request_failed', obligation_count: 1 },
  }, source, []), /failure|candidate/u);

  const quotedSource = { ...source, completion: 'The phrase "API is live" is only quoted.' };
  const quotedCandidates = detectClaims(quotedSource.completion);
  assert.ok(quotedCandidates.length > 0);
  const impossible = {
    ...row,
    completion_sha256: crypto.createHash('sha256').update(quotedSource.completion).digest('hex'),
    detector: { status: 'ok', failure: null, candidate_count: quotedCandidates.length, obligations: [], rejected: [] },
    coverage: {
      ...row.coverage, keyword_candidate_count: quotedCandidates.length,
      zero_candidate: false, detector_status: 'ok', detector_failure: null,
    },
  };
  assert.throws(() => validateArtifactCoverage(impossible, quotedSource, quotedCandidates), /partition|rejected|candidate/u);
});

test('scoring rejects reversed locked lane identities', () => {
  const { a, b } = lanes();
  assert.throws(() => scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: b, laneBRows: a, adjudicationRows: [], matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  }), /lane-a|locked|model/u);
});

test('untrusted label rows with impossible attempt accounting are rejected', () => {
  const { a, b } = lanes();
  const tampered = a.map((row) => ({ ...row }));
  tampered[0].attempts = 1;
  tampered[0].operational_failure_attempts = 1;
  assert.throws(() => scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: tampered, laneBRows: b, adjudicationRows: [], matcher: matcherDescriptor(ROOT),
  }), /violates schema/u);
});
