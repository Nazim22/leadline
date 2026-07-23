'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createPlanner } = require('../src/planner');

const POLICY = { tellsPath: path.join(__dirname, '..', 'policy', 'tells.yaml'), routesPath: path.join(__dirname, '..', 'policy', 'routes.yaml') };

// Stub classifier — no network. Routes clauses containing "widget" to historical, else abstains.
const stub = { classify: async (t) => (/widget/i.test(t) ? { family: 'historical', score: 0.9 } : { family: null, reason: 'abstain-class' }) };

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
});

test('planner without a classifier: planSemantic === plan (tells only)', async () => {
  const p = createPlanner({ ...POLICY });
  const a = await p.planSemantic('who calls chargeCard');
  const b = p.plan('who calls chargeCard');
  assert.deepStrictEqual(a, b);
});
