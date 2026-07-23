'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreRoutes, scoreSatisfaction } = require('../src/benchmark');

test('computes route metrics with explicit sample size', () => {
  const metrics = scoreRoutes([
    { gold_route: ['historical'], predicted_route: ['historical'] },
    { gold_route: ['structural', 'repository'], predicted_route: ['structural'] },
    { gold_route: [], predicted_route: [] },
  ]);

  assert.equal(metrics.sample_size, 3);
  assert.equal(metrics.first_route_correct, 3);
  assert.equal(metrics.full_plan_correct, 2);
  assert.equal(metrics.abstained, 1);
  assert.equal(metrics.multi_intent_cases, 1);
  assert.equal(metrics.multi_intent_families_recalled, 1);
  assert.equal(metrics.multi_intent_families_total, 2);
});

test('reports gate-gaming bypasses separately from legitimate satisfaction', () => {
  const metrics = scoreSatisfaction([
    { id: 'sat-relevant', expected: { satisfied: true }, actual: { satisfied: true } },
    { id: 'sat-empty-gaming', expected: { satisfied: false }, actual: { satisfied: false } },
    { id: 'sat-irrelevant', expected: { satisfied: false }, actual: { satisfied: true } },
  ]);

  assert.equal(metrics.sample_size, 3);
  assert.equal(metrics.correct, 2);
  assert.equal(metrics.adversarial_cases, 2);
  assert.equal(metrics.gate_gaming_bypasses, 1);
});
