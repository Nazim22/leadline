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
  labelingRuntimeBound,
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
const { buildUnion, candidateIdentity, finalizeCandidate, LANE_MODELS, PROTOCOL_VERSION, UNION_SEED, protocolDescriptor } = require('../scripts/adjudicate-union');

const ROOT = path.join(__dirname, '..');
const runtimeFixture = () => ({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), blobs: { 'scripts/score-exam.js': 'c'.repeat(40) } });
const inputHashesFixture = () => ({
  corpus_sha256: 'd'.repeat(64), context_sha256: 'd'.repeat(64), manifest_sha256: 'd'.repeat(64),
  coverage_summary_sha256: 'd'.repeat(64), artifact_sha256: 'd'.repeat(64), lane_a_sha256: 'd'.repeat(64),
  lane_b_sha256: 'd'.repeat(64), labeling_summary_sha256: 'd'.repeat(64), adjudication_sha256: 'd'.repeat(64),
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

function label(completionId, labelerId, claims, status = 'ok') {
  const identity = labelerId === 'lane-a' ? LANE_MODELS.grok : LANE_MODELS.kimi;
  return {
    schema_version: 2,
    rubric_version: 'detector-gold-v0.2',
    rubric_sha256: RUBRIC_SHA256,
    completion_id: completionId,
    labeler: {
      id: labelerId,
      request_model: identity.request_model,
      model_identity: identity.model_identity,
    },
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
    label('completion-111111111111111111111111', 'lane-a', [claim('The API is live.', 'runtime', 'API', 0.99)]),
    label('completion-222222222222222222222222', 'lane-a', [claim('The tests passed.', 'runtime', 'tests')]),
    label('completion-333333333333333333333333', 'lane-a', []),
    label('completion-444444444444444444444444', 'lane-a', [claim('The build passed.', 'runtime', 'build')]),
  ];
  const b = [
    label('completion-111111111111111111111111', 'lane-b', [{ ...claim('The API is live.', 'runtime', 'api', 0.7), relevant_evidence_contact_visible: 'uncertain' }]),
    label('completion-222222222222222222222222', 'lane-b', []),
    label('completion-333333333333333333333333', 'lane-b', []),
    label('completion-444444444444444444444444', 'lane-b', [claim('The build passed.', 'runtime', 'build')]),
  ];
  return { a, b };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sealedAdjudication(complete = false) {
  const protocol = protocolDescriptor();
  const sources = corpusRows();
  const { a, b } = lanes();
  const laneMaps = [new Map(a.map((row) => [row.completion_id, row])), new Map(b.map((row) => [row.completion_id, row]))];
  const rows = sources.map((source) => {
    const laneRows = laneMaps.map((lane) => lane.get(source.completion_id));
    const union = buildUnion({
      completion_id: source.completion_id,
      completion: source.completion,
      seed: UNION_SEED,
      lanes: laneRows.map((row) => ({ id: row.labeler.id, status: row.status, claims: row.claims })),
    });
    const candidates = union.map((candidate) => {
      const votes = {
        grok: candidate.lane_votes['lane-a'],
        kimi: candidate.lane_votes['lane-b'],
        gemini: source.completion_id.includes('2222') && !complete ? 'abstain' : 'accept',
      };
      return { ...candidate, votes, decision: finalizeCandidate(votes) };
    });
    return {
      completion_id: source.completion_id,
      sweep_status: 'ok',
      candidates,
      gold_claims: candidates.filter((item) => item.decision === 'accept').map((item) => ({
        span_exact_text: item.span_exact_text, family: item.family, entity: item.entity,
      })),
    };
  });
  return {
    schema_version: 2,
    protocol_version: PROTOCOL_VERSION,
    protocol_sha256: crypto.createHash('sha256').update(canonicalJson(protocol)).digest('hex'),
    rubric_version: 'detector-gold-v0.2', rubric_sha256: RUBRIC_SHA256,
    seed: UNION_SEED,
    identities: protocol.identities,
    runtime: runtimeFixture(),
    inputs: {
      corpus_sha256: inputHashesFixture().corpus_sha256,
      context_sha256: inputHashesFixture().context_sha256,
      lane_a_sha256: inputHashesFixture().lane_a_sha256,
      lane_b_sha256: inputHashesFixture().lane_b_sha256,
      labeling_summary_sha256: inputHashesFixture().labeling_summary_sha256,
    },
    schema_hashes: protocol.schema_hashes,
    status: complete ? 'COMPLETE' : 'PENDING_ADJUDICATION',
    invalid_response_attempts: 0,
    operational_failure_attempts: 0,
    operational_failure_requests: 0,
    rows,
  };
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

test('sealed candidate abstention forces pending while inter-rater agreement remains diagnostic only', () => {
  const { a, b } = lanes();
  const result = scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudication: sealedAdjudication(false), matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  });

  assert.equal(result.gold_rows.length, 4);
  assert.equal(result.adjudication_queue.length, 1);
  assert.equal(result.adjudication_queue[0].completion_id, 'completion-222222222222222222222222');
  assert.equal(result.adjudication_queue[0].reason, 'candidate_abstention');
  assert.equal(result.score.exam_status, 'PENDING_ADJUDICATION');
  assert.equal(result.score.inter_rater_diagnostic.gating, false);
  assert.deepEqual(result.score.inter_rater_diagnostic.exact_completion_agreement, { numerator: 3, denominator: 4, value: 0.75 });
  assert.deepEqual(result.score.inter_rater_diagnostic.claim_existence_kappa, { numerator: 0.25, denominator: 0.5, value: 0.5, rated_rows: 4 });

  assert.deepEqual(result.score.metrics.precision, { numerator: 1, denominator: 3, value: 1 / 3 });
  assert.deepEqual(result.score.metrics.recall, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(result.score.metrics.gold_zero_false_positive_rate, { numerator: 2, denominator: 2, value: 1 });
  assert.deepEqual(result.score.metrics.operational_failure_rate, { numerator: 1, denominator: 4, value: 0.25 });
});

test('sealed two-of-three adjudication completes gold, emits final gate verdict, and validates schema', () => {
  const { a, b } = lanes();
  const result = scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudication: sealedAdjudication(true), matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
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

  const tampered = sealedAdjudication(true);
  tampered.runtime = { ...tampered.runtime, tree: 'a'.repeat(40) };
  assert.throws(() => scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudication: tampered, matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  }), /runtime/u);

  const wrongInputs = sealedAdjudication(true);
  wrongInputs.inputs.lane_a_sha256 = 'f'.repeat(64);
  assert.throws(() => scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudication: wrongInputs, matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  }), /exact corpus, context, lanes/u);

  const omittedUnion = sealedAdjudication(true);
  omittedUnion.rows[0].candidates = [];
  omittedUnion.rows[0].gold_claims = [];
  assert.throws(() => scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudication: omittedUnion, matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  }), /deterministic derivation/u);

  const forgedLaneVote = sealedAdjudication(true);
  forgedLaneVote.rows[0].candidates[0].lane_votes['lane-a'] = 'reject';
  forgedLaneVote.rows[0].candidates[0].votes.grok = 'reject';
  forgedLaneVote.rows[0].candidates[0].decision = finalizeCandidate(forgedLaneVote.rows[0].candidates[0].votes);
  forgedLaneVote.rows[0].gold_claims = [];
  assert.throws(() => scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudication: forgedLaneVote, matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  }), /deterministic derivation/u);

  const forgedSweep = sealedAdjudication(true);
  const represented = forgedSweep.rows[0].candidates[0];
  const containedText = 'API is live.';
  const containedStart = corpusRows()[0].completion.indexOf(containedText);
  const sweepCandidate = {
    ...represented,
    span_exact_text: containedText,
    start: containedStart,
    end: containedStart + containedText.length,
    source: 'completeness_sweep',
    lane_votes: { grok: 'accept', kimi: 'accept' },
    votes: { grok: 'accept', kimi: 'accept', gemini: 'accept' },
    decision: 'accept',
  };
  sweepCandidate.candidate_id = candidateIdentity(UNION_SEED, forgedSweep.rows[0].completion_id, sweepCandidate);
  forgedSweep.rows[0].candidates.push(sweepCandidate);
  forgedSweep.rows[0].gold_claims.push({
    span_exact_text: sweepCandidate.span_exact_text, family: sweepCandidate.family, entity: sweepCandidate.entity,
  });
  assert.throws(() => scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudication: forgedSweep, matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  }), /completeness-sweep candidate/u);

  const unsupportedInvalid = sealedAdjudication(true);
  unsupportedInvalid.status = 'INVALID_EXAM';
  unsupportedInvalid.rows = [];
  assert.throws(() => scoreExam({
    corpusRows: corpusRows(), contextRows: contextRows(), artifactRows: artifacts(),
    laneARows: a, laneBRows: b, adjudication: unsupportedInvalid, matcher: matcherDescriptor(ROOT),
    runtime: runtimeFixture(), inputHashes: inputHashesFixture(),
  }), /violates schema/u);
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
    laneARows: b, laneBRows: a, adjudication: sealedAdjudication(true), matcher: matcherDescriptor(ROOT),
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

function causalRuntimeFixtures() {
  const current = { blobs: {
    'scripts/label-corpus.js': '1'.repeat(40),
    'schema/exam-label.schema.json': '2'.repeat(40),
    'scripts/score-exam.js': '3'.repeat(40),
    'schema/exam-score.schema.json': '4'.repeat(40),
  } };
  const recorded = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), blobs: { ...current.blobs } };
  return { current, recorded };
}

test('labeling runtime binding permits scorer-only byte drift', () => {
  const { current, recorded } = causalRuntimeFixtures();
  recorded.blobs['scripts/score-exam.js'] = '5'.repeat(40);
  recorded.blobs['schema/exam-score.schema.json'] = '6'.repeat(40);
  assert.equal(labelingRuntimeBound(recorded, current), true);
});

test('labeling runtime binding rejects labeler executable byte drift', () => {
  const { current, recorded } = causalRuntimeFixtures();
  recorded.blobs['scripts/label-corpus.js'] = '7'.repeat(40);
  assert.equal(labelingRuntimeBound(recorded, current), false);
});

test('labeling runtime binding rejects a missing provenance path', () => {
  const { current, recorded } = causalRuntimeFixtures();
  delete recorded.blobs['schema/exam-label.schema.json'];
  assert.equal(labelingRuntimeBound(recorded, current), false);
});

test('labeling runtime binding rejects an extra provenance path', () => {
  const { current, recorded } = causalRuntimeFixtures();
  recorded.blobs['scripts/unbound.js'] = '8'.repeat(40);
  assert.equal(labelingRuntimeBound(recorded, current), false);
});
