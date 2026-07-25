'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreRoutes, scoreSatisfaction } = require('../src/benchmark');

test('reports honest route denominators and excludes correct abstentions from route accuracy', () => {
  const metrics = scoreRoutes([
    { gold_route: ['historical'], predicted_route: ['historical'], predicted_complete: true },
    { gold_route: ['structural', 'repository'], predicted_route: ['structural'], predicted_complete: true },
    { gold_route: [], predicted_route: [], predicted_complete: false },
    { gold_route: ['runtime'], predicted_route: ['runtime'], predicted_complete: false },
  ]);

  assert.equal(metrics.sample_size, 4);
  assert.equal(metrics.routed_cases, 3);
  assert.equal(metrics.first_route_correct, 3);
  assert.equal(metrics.full_plan_correct, 2);
  assert.equal(metrics.abstained, 1);
  assert.equal(metrics.multi_intent_cases, 1);
  assert.equal(metrics.multi_intent_families_recalled, 1);
  assert.equal(metrics.multi_intent_families_total, 2);
});

test('separates gate-gaming bypasses, freshness rejections, and false blocks', () => {
  const metrics = scoreSatisfaction([
    { id: 'sat-relevant', expected: { satisfied: true, failure: 'none' }, actual: { satisfied: true, failure: 'none' } },
    { id: 'sat-empty-gaming', expected: { satisfied: false, failure: 'empty' }, actual: { satisfied: false, failure: 'empty' } },
    { id: 'sat-irrelevant', expected: { satisfied: false, failure: 'irrelevant' }, actual: { satisfied: true, failure: 'none' } },
    { id: 'sat-stale', expected: { satisfied: false, failure: 'stale' }, actual: { satisfied: true, failure: 'none' } },
  ]);

  assert.equal(metrics.sample_size, 4);
  assert.equal(metrics.correct, 2);
  assert.equal(metrics.gate_gaming_cases, 2);
  assert.equal(metrics.gate_gaming_bypasses, 1);
  assert.equal(metrics.freshness_cases, 1);
  assert.equal(metrics.freshness_rejections, 0);
  assert.equal(metrics.legitimate_cases, 1);
  assert.equal(metrics.false_blocks, 0);
});
