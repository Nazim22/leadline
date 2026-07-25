'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertRawFieldsMatch,
  measureCalibration,
  rankCandidates,
  buildCoverageRiskTable,
  buildStratifiedReport,
  isExactPlan,
  validateLabeledRows,
} = require('../src/calibration');

const rows = [
  { id: 'a', prompt: 'past?', source_hash: '1', cluster_id: 'c1', session_hash: 's1', gold_route: ['historical'], label_confidence: 'high', context_dependency: 'none', rubric_version: 'real-v1', labeler: 'x', label_note: '' },
  { id: 'b', prompt: 'live?', source_hash: '2', cluster_id: 'c2', session_hash: 's2', gold_route: ['runtime'], label_confidence: 'medium', context_dependency: 'referent', rubric_version: 'real-v1', labeler: 'x', label_note: '' },
  { id: 'c', prompt: 'build it', source_hash: '3', cluster_id: 'c3', session_hash: 's3', gold_route: [], label_confidence: 'high', context_dependency: 'none', rubric_version: 'real-v1', labeler: 'x', label_note: '' },
];

test('labeled calibration rows are strict and unique', () => {
  assert.equal(validateLabeledRows(rows).length, 3);
  assert.throws(() => validateLabeledRows([{ ...rows[0], gold_route: undefined }]), /gold_route/);
  assert.throws(() => validateLabeledRows([{ ...rows[0], label_note: undefined }]), /label_note/);
  assert.throws(() => validateLabeledRows([rows[0], { ...rows[1], id: 'a' }]), /duplicate id/);
  assert.throws(() => validateLabeledRows([{ ...rows[0], gold_route: ['web'] }]), /invalid route family/);
  assert.throws(() => validateLabeledRows([{ ...rows[0], label_agreement: 'maybe' }]), /label_agreement/);
});

test('labeled calibration rows must preserve every raw source field and order', () => {
  const raw = rows.map(({ id, prompt, source_hash, cluster_id, session_hash }) => ({ id, prompt, source_hash, cluster_id, session_hash }));
  assert.doesNotThrow(() => assertRawFieldsMatch(raw, rows));
  assert.throws(() => assertRawFieldsMatch(raw, [{ ...rows[0], prompt: 'changed' }, rows[1], rows[2]]), /raw field mismatch.*prompt/);
  assert.throws(() => assertRawFieldsMatch(raw, [rows[1], rows[0], rows[2]]), /raw field mismatch.*id/);
});

test('calibration metrics count wrong-family routes against precision and recall', () => {
  const predictions = [
    { id: 'a', predicted_route: ['historical'], complete: true },
    { id: 'b', predicted_route: ['historical'], complete: true },
    { id: 'c', predicted_route: ['runtime'], complete: true },
  ];
  const metrics = measureCalibration(rows, predictions);
  assert.equal(metrics.counts.correct_first_family, 1);
  assert.equal(metrics.counts.predicted_routed, 3);
  assert.equal(metrics.counts.gold_routed, 2);
  assert.equal(metrics.routed_first_family_precision, 1 / 3);
  assert.equal(metrics.routed_evidence_request_recall, 1 / 2);
  assert.equal(metrics.false_route_rate_on_true_abstains, 1);
});

test('exact plan requires a complete contract', () => {
  const predictions = [
    { id: 'a', predicted_route: ['historical'], complete: false },
    { id: 'b', predicted_route: [], complete: false },
    { id: 'c', predicted_route: [], complete: true },
  ];
  assert.equal(measureCalibration(rows, predictions).counts.exact_plan, 1);
});

test('candidate ranking rejects vacuous and constraint-violating configurations', () => {
  const objective = { constraints: {
    routed_first_family_precision: { minimum: 0.9 },
    false_route_rate_on_true_abstains: { maximum: 0.02 },
  } };
  const candidates = [
    { config: { floor: 0.5 }, metrics: { routed_first_family_precision: 1, false_route_rate_on_true_abstains: 0, routed_evidence_request_recall: 0, macro_first_family_recall: 0, gold_abstention_recall: 1, counts: { predicted_routed: 0 } } },
    { config: { floor: 0.6 }, metrics: { routed_first_family_precision: 0.8, false_route_rate_on_true_abstains: 0, routed_evidence_request_recall: 0.8, macro_first_family_recall: 0.8, gold_abstention_recall: 1, counts: { predicted_routed: 10 } } },
    { config: { floor: 0.7 }, metrics: { routed_first_family_precision: 0.95, false_route_rate_on_true_abstains: 0.01, routed_evidence_request_recall: 0.5, macro_first_family_recall: 0.4, gold_abstention_recall: 0.99, counts: { predicted_routed: 10 } } },
  ];
  const ranked = rankCandidates(candidates, objective);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].config.floor, 0.7);
});

test('reports frozen calibration strata and exact-plan misses', () => {
  const predictions = [
    { id: 'a', predicted_route: ['historical'], complete: true },
    { id: 'b', predicted_route: ['runtime'], complete: true },
    { id: 'c', predicted_route: [], complete: true },
  ];
  const report = buildStratifiedReport(rows, predictions);
  assert.equal(report.definitions.terse, 'normalized whitespace token count <= 8');
  assert.equal(report.gold_family.historical.counts.total, 1);
  assert.equal(report.route_cardinality.abstain.counts.total, 1);
  assert.equal(report.label_agreement.not_recorded.counts.total, 3);
  assert.equal(isExactPlan(rows[0], predictions[0]), true);
  assert.equal(isExactPlan({ ...rows[0], gold_route: ['historical', 'runtime'] }, predictions[0]), false);
});

test('coverage-risk table is deterministic and keeps the best risk at each coverage', () => {
  const table = buildCoverageRiskTable([
    { metrics: { counts: { total: 100, predicted_routed: 10 }, routed_first_family_precision: 0.9, routed_evidence_request_recall: 0.2, false_route_rate_on_true_abstains: 0.01 } },
    { metrics: { counts: { total: 100, predicted_routed: 10 }, routed_first_family_precision: 0.95, routed_evidence_request_recall: 0.19, false_route_rate_on_true_abstains: 0 } },
    { metrics: { counts: { total: 100, predicted_routed: 20 }, routed_first_family_precision: 0.8, routed_evidence_request_recall: 0.3, false_route_rate_on_true_abstains: 0.03 } },
  ]);
  assert.deepEqual(table.map((point) => point.predicted_routed), [10, 20]);
  assert.equal(table[0].routed_first_family_precision, 0.95);
});
