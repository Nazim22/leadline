'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRealReport,
  buildRouteDiagnostics,
  scoreRoutes,
  scoreSatisfaction,
} = require('../src/benchmark');

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

test('multi-intent recall consumes duplicate predicted families only once', () => {
  const metrics = scoreRoutes([{
    gold_route: ['structural', 'repository', 'structural'],
    predicted_route: ['structural', 'repository'],
    predicted_complete: true,
  }]);

  assert.equal(metrics.multi_intent_families_recalled, 2);
  assert.equal(metrics.multi_intent_families_total, 3);
});

test('builds deterministic first-route confusion pairs and an honest miss list', () => {
  const rows = [
    { id: 'a', prompt: 'a', gold_route: ['historical'], predicted_route: ['repository'], predicted_complete: true, unmatched_clauses: [] },
    { id: 'b', prompt: 'b', gold_route: ['runtime'], predicted_route: [], predicted_complete: false, unmatched_clauses: [{ index: 0 }] },
    { id: 'c', prompt: 'c', gold_route: [], predicted_route: ['repository'], predicted_complete: true, unmatched_clauses: [] },
    { id: 'd', prompt: 'd', gold_route: ['structural'], predicted_route: ['structural'], predicted_complete: false, unmatched_clauses: [{ index: 1 }] },
    { id: 'e', prompt: 'e', gold_route: [], predicted_route: [], predicted_complete: false, unmatched_clauses: [{ index: 0 }] },
  ];

  const diagnostics = buildRouteDiagnostics(rows);
  assert.deepEqual(diagnostics.first_route_confusions, [
    { gold: '<abstain>', predicted: 'repository', count: 1 },
    { gold: 'historical', predicted: 'repository', count: 1 },
    { gold: 'runtime', predicted: '<abstain>', count: 1 },
  ]);
  assert.deepEqual(diagnostics.misses.map((row) => row.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(diagnostics.gold_route_distribution, [
    { route: '<abstain>', count: 2 },
    { route: 'historical', count: 1 },
    { route: 'runtime', count: 1 },
    { route: 'structural', count: 1 },
  ]);
});

test('builds a denominator-explicit real-corpus report without latency noise', () => {
  const rows = [
    { id: 'a', gold_route: ['historical'], predicted_route: ['historical'], predicted_complete: true, unmatched_clauses: [], label_confidence: 'high', context_dependency: 'none' },
    { id: 'b', gold_route: ['runtime'], predicted_route: [], predicted_complete: false, unmatched_clauses: [{ index: 0 }], label_confidence: 'medium', context_dependency: 'referent' },
    { id: 'c', gold_route: [], predicted_route: [], predicted_complete: false, unmatched_clauses: [{ index: 0 }], label_confidence: 'high', context_dependency: 'none' },
  ];
  const evaluation = { rows, metrics: { ...scoreRoutes(rows), latency_ms: 999.123 } };
  const report = buildRealReport(evaluation, {
    corpus_commit: 'raw-sha',
    router_commit: 'router-sha',
    rubric_version: 'real-v1',
    labeler: 'dae',
  });

  assert.deepEqual(report.metrics.first_route_accuracy, { correct: 1, total: 2, rate: 0.5 });
  assert.deepEqual(report.metrics.full_plan_exact_match, { correct: 2, total: 3, rate: 2 / 3 });
  assert.deepEqual(report.metrics.multi_intent_recall, { recalled: 0, total: 0, rate: null, cases: 0 });
  assert.equal(Object.hasOwn(report.metrics, 'latency_ms'), false);
  assert.deepEqual(report.annotation_distribution.confidence, { high: 2, medium: 1 });
  assert.deepEqual(report.annotation_distribution.context_dependency, { none: 2, referent: 1 });
  assert.deepEqual(report.diagnostics.misses.map((row) => row.id), ['b']);
});
