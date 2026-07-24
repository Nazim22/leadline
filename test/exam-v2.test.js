'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  LABELER_MODELS,
  LABEL_RUBRIC,
  LABEL_RUBRIC_PROMPT,
  MODEL_RESPONSE_SCHEMA,
  RUBRIC_SHA256,
  RUBRIC_VERSION,
  labelCorpus,
  validateConfig,
} = require('../scripts/label-corpus');
const {
  ADJUDICATOR_MODEL,
  PROTOCOL_VERSION,
  REQUEST_PROFILES,
  UNION_SEED,
  VOTE_RESPONSE_SCHEMA,
  assertPathSeparation,
  buildUnion,
  finalizeCandidate,
  protocolDescriptor,
  runAdjudication,
  seededCandidateOrder,
  structuredRequest,
} = require('../scripts/adjudicate-union');
const { scoreExam } = require('../scripts/score-exam');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const completionId = 'completion-111111111111111111111111';
const corpusRows = [{
  schema_version: 1,
  completion_id: completionId,
  session_id: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
  turn_id: 'turn-1',
  completed_at: '2026-07-24T02:00:00.000Z',
  completion: 'The API is live and 37/37 tests passed.',
  strata: ['keyword_positive'],
  tool_calls: [],
}];
const contextRows = [{
  schema_version: 1,
  completion_id: completionId,
  session_id: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
  target_turn_id: 'turn-1',
  preceding_turn_id: 'turn-0',
  messages: [{ role: 'user', content: 'What is the current state?' }],
}];
const config = {
  schema_version: 2,
  base_url: 'https://openrouter.ai/api/v1',
  labelers: [
    { id: 'lane-a', request_model: 'x-ai/grok-4.5', model_identity: 'x-ai/grok-4.5', request_profile: 'deterministic-v1' },
    { id: 'lane-b', request_model: 'moonshotai/kimi-k3-20260715', model_identity: 'moonshotai/kimi-k3', request_profile: 'provider-default-v1' },
  ],
};
const claim = (span_exact_text, family, entity) => ({ span_exact_text, family, entity });

function inputBytes() {
  const corpusText = `${corpusRows.map(JSON.stringify).join('\n')}\n`;
  const contextText = `${contextRows.map(JSON.stringify).join('\n')}\n`;
  return { corpusText, contextText, expectedContextSha256: sha256(contextText) };
}

function response(model, claims) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { model, choices: [{ message: { content: JSON.stringify({ schema_version: 2, claims }) } }] };
    },
  };
}

test('v2 rubric hash freezes exactly five synthetic anchors and every launch descriptor', () => {
  assert.equal(RUBRIC_VERSION, 'detector-gold-v0.2');
  assert.equal(LABEL_RUBRIC.synthetic_anchors.length, 5);
  assert.equal(RUBRIC_SHA256, sha256(JSON.stringify(LABEL_RUBRIC)));
  assert.match(LABEL_RUBRIC_PROMPT, /synthetic anchors/iu);
  assert.deepEqual(LABELER_MODELS, [
    { request_model: 'x-ai/grok-4.5', model_identity: 'x-ai/grok-4.5', request_profile: 'deterministic-v1' },
    { request_model: 'moonshotai/kimi-k3-20260715', model_identity: 'moonshotai/kimi-k3', request_profile: 'provider-default-v1' },
  ]);
  assert.deepEqual(ADJUDICATOR_MODEL, {
    request_model: 'google/gemini-3.6-flash',
    model_identity: 'google/gemini-3.6-flash',
    request_profile: 'deterministic-v1',
  });
  assert.equal(PROTOCOL_VERSION, 'exam-v2.1');
  assert.deepEqual(REQUEST_PROFILES, {
    'deterministic-v1': { temperature: 0, seed: 0 },
    'provider-default-v1': {},
  });
  assert.deepEqual(protocolDescriptor().request_profiles, {
    grok: 'deterministic-v1',
    kimi: 'provider-default-v1',
    gemini: 'deterministic-v1',
  });
  assert.equal(typeof UNION_SEED, 'string');
  assert.equal(MODEL_RESPONSE_SCHEMA.properties.schema_version.const, 2);
});

test('lane requests are concurrent and enforce strict schema, parameters, no fallback, and response identity', async () => {
  const started = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const fetchFn = async (_url, options) => {
    const body = JSON.parse(options.body);
    started.push(body.model);
    if (started.length === 2) release();
    await barrier;
    const identity = body.model === 'moonshotai/kimi-k3-20260715' ? 'moonshotai/kimi-k3' : body.model;
    assert.deepEqual(body.provider, { require_parameters: true, allow_fallbacks: false });
    assert.deepEqual(body.response_format, {
      type: 'json_schema',
      json_schema: { name: 'leadline_detector_gold_v2', strict: true, schema: MODEL_RESPONSE_SCHEMA },
    });
    assert.equal(Object.hasOwn(body, 'models'), false);
    return response(identity, [claim('The API is live', 'runtime', 'API')]);
  };
  const result = await labelCorpus({
    corpusRows, contextRows, config, apiKey: 'test-key', fetchFn, inputBytes: inputBytes(),
  });
  assert.deepEqual(started.sort(), ['moonshotai/kimi-k3-20260715', 'x-ai/grok-4.5']);
  assert.equal(result.lanes.length, 2);

  const mismatch = async (_url, options) => response(JSON.parse(options.body).model, []);
  const failed = await labelCorpus({
    corpusRows, contextRows, config, apiKey: 'test-key', fetchFn: mismatch, inputBytes: inputBytes(),
  });
  assert.equal(failed.lanes.find((lane) => lane.labeler_id === 'lane-b').rows[0].failure, 'model_identity_mismatch');
});

test('Kimi config is fail-closed on the exact request and pinned response identities', () => {
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({
    ...config,
    labelers: config.labelers.map((lane) => lane.id === 'lane-b' ? { ...lane, model_identity: 'kimi-k3-20260715' } : lane),
  }), /locked|identity|lane-b/iu);
  assert.throws(() => validateConfig({
    ...config,
    labelers: config.labelers.map((lane) => lane.id === 'lane-b' ? { ...lane, request_model: 'moonshotai/kimi-k3:free' } : lane),
  }), /locked|identity|lane-b/iu);
  assert.throws(() => validateConfig({
    ...config,
    labelers: config.labelers.map((lane) => lane.id === 'lane-b' ? { ...lane, request_profile: 'deterministic-v1' } : lane),
  }), /locked|profile|lane-b/iu);
});

test('union clustering is deterministic, containment-only, and never similarity-based', () => {
  const completion = 'The API is live right now. The API appears lively.';
  const lanes = [
    { id: 'lane-a', claims: [claim('The API is live right now.', 'runtime', 'API')] },
    { id: 'lane-b', claims: [
      claim('API is live', 'runtime', 'api'),
      claim('The API appears lively.', 'runtime', 'API'),
    ] },
  ];
  const union = buildUnion({ completion_id: completionId, completion, lanes, seed: UNION_SEED });
  assert.equal(union.length, 2);
  assert.deepEqual(union[0].lane_votes, { 'lane-a': 'accept', 'lane-b': 'accept' });
  assert.deepEqual(union[1].lane_votes, { 'lane-a': 'reject', 'lane-b': 'accept' });
  assert.deepEqual(buildUnion({ completion_id: completionId, completion, lanes: [...lanes].reverse(), seed: UNION_SEED }), union);
  assert.notDeepEqual(seededCandidateOrder(union, UNION_SEED).map((row) => row.candidate_id), union.map((row) => row.candidate_id));

  const failedLane = buildUnion({
    completion_id: completionId, completion,
    lanes: [
      { id: 'lane-a', status: 'operational_failure', claims: null },
      { id: 'lane-b', status: 'ok', claims: [claim('The API is live right now.', 'runtime', 'API')] },
    ],
  });
  assert.deepEqual(failedLane[0].lane_votes, { 'lane-a': 'operational_failure', 'lane-b': 'accept' });
});

test('candidate finalization requires two accepts and preserves undecidable abstention', () => {
  assert.equal(finalizeCandidate({ grok: 'accept', kimi: 'reject', gemini: 'accept' }), 'accept');
  assert.equal(finalizeCandidate({ grok: 'reject', kimi: 'reject', gemini: 'accept' }), 'reject');
  assert.equal(finalizeCandidate({ grok: 'accept', kimi: 'operational_failure', gemini: 'abstain' }), 'abstain');
});

test('adjudicator sweeps every completion and two-of-three validates a sweep-only omission', async () => {
  const laneRow = (id, requestModel, identity) => ({
    schema_version: 2, rubric_version: RUBRIC_VERSION, rubric_sha256: RUBRIC_SHA256,
    completion_id: completionId,
    labeler: { id, request_model: requestModel, model_identity: identity },
    status: 'ok', attempts: 1, invalid_attempts: 0, operational_failure_attempts: 0,
    claims: [claim('The API is live', 'runtime', 'API')], failure: null,
  });
  const calls = [];
  let sweepAttempts = 0;
  const fetchFn = async (_url, options) => {
    const body = JSON.parse(options.body);
    const payload = JSON.parse(body.messages[1].content);
    calls.push({ body, payload });
    assert.deepEqual(body.provider, { require_parameters: true, allow_fallbacks: false });
    assert.equal(Object.hasOwn(body, 'models'), false);
    const name = body.response_format.json_schema.name;
    let value;
    if (name === 'leadline_completeness_sweep_v2') {
      sweepAttempts += 1;
      value = { schema_version: 2, missing_claims: [
        claim(sweepAttempts === 1 ? 'not in source' : '37/37 tests passed.', 'runtime', 'tests'),
      ] };
    } else {
      value = { schema_version: 2, candidate_id: payload.candidate.candidate_id, decision: 'accept' };
    }
    const identity = body.model === 'moonshotai/kimi-k3-20260715' ? 'moonshotai/kimi-k3' : body.model;
    return {
      ok: true, status: 200,
      async json() { return { model: identity, choices: [{ message: { content: JSON.stringify(value) } }] }; },
    };
  };
  const result = await runAdjudication({
    corpusRows, contextRows,
    laneARows: [laneRow('lane-a', 'x-ai/grok-4.5', 'x-ai/grok-4.5')],
    laneBRows: [laneRow('lane-b', 'moonshotai/kimi-k3-20260715', 'moonshotai/kimi-k3')],
    apiKey: 'test-key', fetchFn,
  });
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(result.rows[0].gold_claims, [
    claim('The API is live', 'runtime', 'API'),
    claim('37/37 tests passed.', 'runtime', 'tests'),
  ]);
  assert.equal(calls.filter((call) => call.body.response_format.json_schema.name === 'leadline_completeness_sweep_v2').length, 2);
  assert.equal(result.invalid_response_attempts, 1);
  assert.equal(result.operational_failure_attempts, 0);
  const geminiCandidate = calls.find((call) => call.body.response_format.json_schema.name === 'leadline_candidate_vote_v2');
  assert.equal(JSON.stringify(geminiCandidate.payload).includes('lane-a'), false);
  assert.equal(JSON.stringify(geminiCandidate.payload).includes('lane-b'), false);
  assert.deepEqual(calls.filter((call) => call.body.response_format.json_schema.name === 'leadline_sweep_validation_v2')
    .map((call) => call.body.model).sort(), ['moonshotai/kimi-k3-20260715', 'x-ai/grok-4.5']);
  const kimiCalls = calls.filter((call) => call.body.model === 'moonshotai/kimi-k3-20260715');
  assert.ok(kimiCalls.length > 0);
  assert.equal(kimiCalls.every((call) => !Object.hasOwn(call.body, 'temperature') && !Object.hasOwn(call.body, 'seed')), true);
  assert.equal(calls.filter((call) => call.body.model !== 'moonshotai/kimi-k3-20260715')
    .every((call) => call.body.temperature === 0 && call.body.seed === 0), true);
});

test('adjudicator correlates candidate response IDs and counts mismatches as invalid responses', async () => {
  let attempts = 0;
  const result = await structuredRequest({
    endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'test-key',
    model: ADJUDICATOR_MODEL, schema: VOTE_RESPONSE_SCHEMA, schemaName: 'vote',
    payload: {}, system: 'blind vote', expectedCandidateId: 'candidate-111111111111111111111111',
    fetchFn: async () => {
      attempts += 1;
      return {
        ok: true,
        async json() {
          return {
            model: ADJUDICATOR_MODEL.model_identity,
            choices: [{ message: { content: JSON.stringify({
              schema_version: 2, candidate_id: 'candidate-222222222222222222222222', decision: 'accept',
            }) } }],
          };
        },
      };
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    status: 'operational_failure', attempts: 2, value: null, failure: 'invalid_response',
    invalid_response_attempts: 2, operational_failure_attempts: 0,
  });
});

test('adjudicator output cannot alias any private input artifact', () => {
  const args = {
    corpus: '/private/corpus.jsonl', context: '/private/context.jsonl',
    'lane-a': '/private/lane-a.jsonl', 'lane-b': '/private/lane-b.jsonl',
    'labeling-summary': '/private/summary.json', output: '/private/corpus.jsonl',
  };
  assert.throws(() => assertPathSeparation(args), /output must differ/u);
  assert.doesNotThrow(() => assertPathSeparation({ ...args, output: '/private/adjudication.json' }));
});

test('v2 scorer rejects whole-completion replacement adjudications', () => {
  const replacement = [{
    schema_version: 1,
    rubric_version: 'detector-gold-v0.1',
    rubric_sha256: 'a'.repeat(64),
    completion_id: completionId,
    labeler: { id: 'human', model_identity: 'human' },
    status: 'ok', attempts: 1, invalid_attempts: 0, operational_failure_attempts: 0,
    claims: [], failure: null,
  }];
  assert.throws(() => scoreExam({ adjudication: replacement }), /whole-completion|v2 adjudication|replacement/iu);
});
