'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLAIM_DETECTOR_PROMPT,
  createConfiguredClaimDetector,
  createClaimObligationDetector,
  validateClaimDecision,
} = require('../src/claim-detector');

const IDENTITY = 'ollama:qwen36-nothink:latest@abc123';

function fakeClient(content, { identity = IDENTITY, error = null } = {}) {
  const calls = [];
  return {
    calls,
    getModelIdentity: async () => identity,
    chatJSON: async (system, user) => {
      calls.push({ system, user });
      if (error) throw error;
      return JSON.stringify(typeof content === 'function' ? content(JSON.parse(user)) : content);
    },
  };
}

test('claim detector skips the LLM when deterministic candidates are absent', async () => {
  const client = fakeClient(null);
  const detector = await createClaimObligationDetector({ llmClient: client, expectedModelIdentity: IDENTITY });
  const result = await detector.detect('Thanks — I will think about that.');
  assert.deepEqual(result.obligations, []);
  assert.equal(result.status, 'ok');
  assert.equal(result.candidate_count, 0);
  assert.equal(client.calls.length, 0);
});

test('claim detector rejects metaphorical and conversational keyword candidates', async () => {
  const client = fakeClient(({ candidates }) => ({
    schema_version: 1,
    decisions: candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      requires_receipt: false,
      family: null,
      entity: null,
      confidence: 0.99,
    })),
  }));
  const detector = await createClaimObligationDetector({ llmClient: client, expectedModelIdentity: IDENTITY });
  const result = await detector.detect('His reply wakes me, so Discord is live — and a subagent is running in the background.');
  assert.equal(result.candidate_count, 2);
  assert.deepEqual(result.obligations, []);
  assert.equal(result.rejected.length, 2);
});

test('claim detector deterministically excludes quoted and inline-code keyword candidates', async () => {
  const client = fakeClient(null);
  const detector = await createClaimObligationDetector({ llmClient: client, expectedModelIdentity: IDENTITY });
  for (const text of [
    'The docs quote says "the code does automatic retries".',
    'Example: `the code does automatic retries`.',
  ]) {
    const result = await detector.detect(text);
    assert.equal(result.candidate_count, 1);
    assert.deepEqual(result.obligations, []);
    assert.equal(result.rejected[0].reason, 'quoted_or_code');
  }
  assert.equal(client.calls.length, 0);
});

test('claim detector confirms factual claims and extracts family and entity', async () => {
  const client = fakeClient(({ candidates }) => ({
    schema_version: 1,
    decisions: candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      requires_receipt: true,
      family: candidate.pattern_family,
      entity: 'cstoregenie-app lambda',
      confidence: 0.96,
    })),
  }));
  const detector = await createClaimObligationDetector({ llmClient: client, expectedModelIdentity: IDENTITY });
  const result = await detector.detect('The cstoregenie-app lambda is live and responding.');
  assert.equal(result.status, 'ok');
  assert.equal(result.obligations.length, 1);
  const [obligation] = result.obligations;
  assert.match(obligation.claim_id, /^claim-[a-f0-9]{16}$/);
  assert.deepEqual({ ...obligation, claim_id: '<stable>' }, {
    claim_id: '<stable>',
    candidate_id: 'runtime-live:0',
    pattern_id: 'runtime-live',
    claim: 'is live and responding.',
    family: 'runtime',
    entity: 'cstoregenie-app lambda',
    confidence: 0.96,
    evidence: 'runtime probe',
  });
  assert.match(result.detector_fingerprint, /^claim-detector-/);
  assert.equal(result.model_identity, IDENTITY);
});

test('claim detector fails closed on model identity drift before inference', async () => {
  const client = fakeClient({}, { identity: 'ollama:qwen36-nothink:latest@changed' });
  await assert.rejects(
    createClaimObligationDetector({ llmClient: client, expectedModelIdentity: IDENTITY }),
    /model identity mismatch/,
  );
  assert.equal(client.calls.length, 0);
});

test('claim detector distinguishes operational failure from semantic rejection', async () => {
  const client = fakeClient(null, { error: new Error('request timed out') });
  const detector = await createClaimObligationDetector({ llmClient: client, expectedModelIdentity: IDENTITY });
  const result = await detector.detect('37/37 tests pass now.');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.failure, 'llm_request_failed');
  assert.equal(result.candidate_count, 1);
  assert.deepEqual(result.obligations, []);
});

test('claim detector rejects malformed, partial, duplicate, and unknown decisions', async () => {
  assert.throws(() => validateClaimDecision({}), /exact keys/);
  assert.throws(() => validateClaimDecision({
    candidate_id: 'x', requires_receipt: true, family: 'runtime', entity: '', confidence: 0.8,
  }), /entity/);

  const invalid = fakeClient({
    schema_version: 1,
    decisions: [
      { candidate_id: 'unknown', requires_receipt: true, family: 'runtime', entity: 'x', confidence: 0.9 },
    ],
  });
  const detector = await createClaimObligationDetector({ llmClient: invalid, expectedModelIdentity: IDENTITY });
  const result = await detector.detect('The lambda is live.');
  assert.equal(result.status, 'invalid_response');
  assert.equal(result.failure, 'llm_schema_invalid');
  assert.deepEqual(result.obligations, []);
});

test('configured detector verifies immutable prompt hash and digest-pinned model identity', async () => {
  const path = require('node:path');
  const configPath = path.join(__dirname, '..', 'policy', 'claim-detector.json');
  const expected = 'ollama:qwen36-nothink:latest@b0d99af8ccedab18c85324da0b2c2b453da719c76c6cc5c2320b6812d81341d5';
  const client = fakeClient(null, { identity: expected });
  const detector = await createConfiguredClaimDetector({ configPath, llmClient: client });
  assert.equal(detector.model_identity, expected);
  assert.match(detector.detector_fingerprint, /^claim-detector-/);
});

test('claim detector prompt is versioned and forbids quoted or metaphorical assertions', () => {
  assert.match(CLAIM_DETECTOR_PROMPT, /quoted/i);
  assert.match(CLAIM_DETECTOR_PROMPT, /metaphor/i);
  assert.match(CLAIM_DETECTOR_PROMPT, /current system, code, deployment, test, or historical state/i);
});
