'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createPlanner } = require('../src/planner');

const POLICY = { tellsPath: path.join(__dirname, '..', 'policy', 'tells.yaml'), routesPath: path.join(__dirname, '..', 'policy', 'routes.yaml') };

function routedVerdict(family, score = 0.9) {
  const runnerUp = family === 'runtime' ? 'historical' : 'runtime';
  return {
    family,
    score,
    candidate_family: family,
    family_score: score,
    runner_up: runnerUp,
    family_margin: 0.2,
    abstain_score: 0.1,
    topk_agreement: 2 / 3,
    route_gate: 'route',
  };
}

function abstainedVerdict(reason = 'below_family_floor') {
  return {
    family: null,
    candidate_family: 'runtime',
    family_score: 0.4,
    runner_up: 'historical',
    family_margin: 0.1,
    abstain_score: 0.5,
    topk_agreement: 2 / 3,
    route_gate: 'abstain',
    abstain_reason: reason,
  };
}

// Stub classifier — no network. Routes clauses containing "widget" to historical, else abstains.
const stub = { classify: async (t) => (/widget/i.test(t) ? routedVerdict('historical') : abstainedVerdict()) };

test('planSemantic falls back to the semantic classifier when tells miss', async () => {
  const p = createPlanner({ ...POLICY, semanticClassifier: stub });
  const c = await p.planSemantic('what is the deal with the widget rollout');
  assert.strictEqual(c.steps.length, 1);
  assert.strictEqual(c.steps[0].need, 'historical');
  assert.match(c.steps[0].classified_by, /^embedding:/);
  assert.strictEqual(c.complete, true);
});

test('planSemantic abstains when neither tells nor semantic resolve', async () => {
  const p = createPlanner({ ...POLICY, semanticClassifier: stub });
  const c = await p.planSemantic('please refactor this later');
  assert.strictEqual(c.abstained, true);
  assert.strictEqual(c.steps.length, 0);
});

test('planSemantic still lets high-precision tells win first', async () => {
  const p = createPlanner({ ...POLICY, semanticClassifier: stub });
  const c = await p.planSemantic('who calls chargeCard');
  assert.strictEqual(c.steps[0].need, 'structural');
  assert.match(c.steps[0].classified_by, /^tell:/);
});

test('planSemantic fails open (abstains) when the classifier throws', async () => {
  const boom = { classify: async () => { throw new Error('ollama down'); } };
  const p = createPlanner({ ...POLICY, semanticClassifier: boom });
  const c = await p.planSemantic('what is the deal with the widget rollout');
  assert.strictEqual(c.abstained, true);
  assert.strictEqual(c.abstain_reason, 'semantic_unavailable');
  assert.strictEqual(c.unmatched_clauses[0].reason, 'semantic_unavailable');
});

test('planSemantic preserves the semantic gate abstention reason', async () => {
  const gated = { fingerprint: 'semantic-test', classify: async () => abstainedVerdict() };
  const p = createPlanner({ ...POLICY, semanticClassifier: gated });
  const c = await p.planSemantic('please inspect the widget state');
  assert.strictEqual(c.abstain_reason, 'semantic_below_family_floor');
  assert.strictEqual(c.unmatched_clauses[0].reason, 'semantic_below_family_floor');
});

test('planSemantic rejects an invalid classifier response without throwing', async () => {
  const valid = routedVerdict('runtime');
  for (const response of [
    null,
    { family: 'web', score: 0.9 },
    { ...valid, candidate_family: 'web' },
    { ...valid, family_score: Number.NaN },
    { ...valid, family_score: 2 },
    { ...valid, family_margin: 3 },
    { ...valid, topk_agreement: 1.1 },
    { ...valid, route_gate: 'abstain' },
    ...['candidate_family', 'family_score', 'runner_up', 'family_margin', 'abstain_score', 'topk_agreement', 'route_gate']
      .map((field) => {
        const malformed = { ...valid };
        delete malformed[field];
        return malformed;
      }),
  ]) {
    const invalid = { fingerprint: 'semantic-invalid', classify: async () => response };
    const p = createPlanner({ ...POLICY, semanticClassifier: invalid });
    const c = await p.planSemantic('please inspect the widget state');
    assert.strictEqual(c.abstained, true);
    assert.strictEqual(c.abstain_reason, 'semantic_invalid_response');
  }
});

test('semantic classifier fingerprint participates in contract provenance', async () => {
  const fingerprinted = { fingerprint: 'semantic-config-abc', classify: stub.classify };
  const p = createPlanner({ ...POLICY, semanticClassifier: fingerprinted });
  const c = await p.planSemantic('what is the deal with the widget rollout');
  assert.match(c.policy_version, /semantic-config-abc/);
  assert.match(c.steps[0].classified_by, /semantic-config-abc/);
});

test('planner without a classifier: planSemantic === plan (tells only)', async () => {
  const p = createPlanner({ ...POLICY });
  const a = await p.planSemantic('who calls chargeCard');
  const b = p.plan('who calls chargeCard');
  assert.deepStrictEqual(a, b);
});
