'use strict';

const FAMILIES = Object.freeze(['historical', 'structural', 'repository', 'runtime']);
const FAMILY_SET = new Set(FAMILIES);
const CONFIDENCE = new Set(['high', 'medium', 'low']);
const DEPENDENCY = new Set(['none', 'referent', 'project', 'both']);

function validateLabeledRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('labeled calibration corpus must be a non-empty array');
  const ids = new Set();
  const clusters = new Set();
  for (const [index, row] of rows.entries()) {
    for (const field of ['id', 'prompt', 'source_hash', 'cluster_id', 'session_hash', 'gold_route', 'label_confidence', 'context_dependency', 'rubric_version', 'labeler', 'label_note']) {
      if (row[field] == null) throw new Error(`row ${index} missing ${field}`);
    }
    for (const field of ['id', 'prompt', 'source_hash', 'cluster_id', 'session_hash', 'rubric_version', 'labeler']) {
      if (typeof row[field] !== 'string' || row[field].length === 0) throw new Error(`row ${index} invalid ${field}`);
    }
    if (ids.has(row.id)) throw new Error(`duplicate id: ${row.id}`);
    if (clusters.has(row.cluster_id)) throw new Error(`duplicate cluster_id: ${row.cluster_id}`);
    ids.add(row.id);
    clusters.add(row.cluster_id);
    if (!Array.isArray(row.gold_route) || row.gold_route.some((family) => !FAMILY_SET.has(family))) {
      throw new Error(`row ${row.id} has invalid route family`);
    }
    if (typeof row.label_note !== 'string') throw new Error(`row ${row.id} has invalid label_note`);
    if (row.label_agreement != null && !['unanimous', 'disputed'].includes(row.label_agreement)) {
      throw new Error(`row ${row.id} has invalid label_agreement`);
    }
    if (row.audit_labeler != null && (typeof row.audit_labeler !== 'string' || !row.audit_labeler)) {
      throw new Error(`row ${row.id} has invalid audit_labeler`);
    }
    if (!CONFIDENCE.has(row.label_confidence)) throw new Error(`row ${row.id} has invalid label_confidence`);
    if (!DEPENDENCY.has(row.context_dependency)) throw new Error(`row ${row.id} has invalid context_dependency`);
    if (row.rubric_version !== 'real-v1') throw new Error(`row ${row.id} has unsupported rubric_version`);
  }
  return rows;
}

function assertRawFieldsMatch(rawRows, labeledRows) {
  if (!Array.isArray(rawRows) || !Array.isArray(labeledRows) || rawRows.length !== labeledRows.length) {
    throw new Error('raw and labeled corpus row counts differ');
  }
  const fields = ['id', 'prompt', 'source_hash', 'cluster_id', 'session_hash'];
  for (let index = 0; index < rawRows.length; index += 1) {
    for (const field of fields) {
      if (rawRows[index]?.[field] !== labeledRows[index]?.[field]) {
        throw new Error(`raw field mismatch at row ${index}: ${field}`);
      }
    }
  }
  return labeledRows;
}

function sameRoute(left, right) {
  return left.length === right.length && left.every((family, index) => family === right[index]);
}

function safeRate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function measureCalibration(rows, predictions) {
  validateLabeledRows(rows);
  if (!Array.isArray(predictions) || predictions.length !== rows.length) throw new Error('prediction count mismatch');
  const family = Object.fromEntries(FAMILIES.map((name) => [name, { gold: 0, correct: 0, predicted: 0 }]));
  let goldRouted = 0;
  let goldAbstain = 0;
  let predictedRouted = 0;
  let correctFirst = 0;
  let falseRoutes = 0;
  let exactPlan = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const prediction = predictions[index];
    if (!prediction || prediction.id !== row.id) throw new Error(`prediction alignment mismatch at row ${index}`);
    if (!Array.isArray(prediction.predicted_route) || prediction.predicted_route.some((name) => !FAMILY_SET.has(name))) {
      throw new Error(`invalid prediction route: ${row.id}`);
    }
    const goldFirst = row.gold_route[0] || null;
    const predictedFirst = prediction.predicted_route[0] || null;
    if (goldFirst) {
      goldRouted += 1;
      family[goldFirst].gold += 1;
    } else {
      goldAbstain += 1;
    }
    if (predictedFirst) {
      predictedRouted += 1;
      family[predictedFirst].predicted += 1;
    }
    if (goldFirst && predictedFirst === goldFirst) {
      correctFirst += 1;
      family[goldFirst].correct += 1;
    }
    if (!goldFirst && predictedFirst) falseRoutes += 1;
    if (sameRoute(row.gold_route, prediction.predicted_route)
        && (row.gold_route.length === 0 || prediction.complete === true)) exactPlan += 1;
  }

  const perFamily = Object.fromEntries(FAMILIES.map((name) => [name, {
    ...family[name],
    recall: safeRate(family[name].correct, family[name].gold),
    precision: safeRate(family[name].correct, family[name].predicted),
  }]));
  const representedRecalls = FAMILIES.map((name) => perFamily[name].recall).filter((value) => value != null);
  const macroRecall = representedRecalls.length
    ? representedRecalls.reduce((sum, value) => sum + value, 0) / representedRecalls.length
    : null;

  return {
    counts: {
      total: rows.length,
      gold_routed: goldRouted,
      gold_abstain: goldAbstain,
      predicted_routed: predictedRouted,
      correct_first_family: correctFirst,
      false_routes_on_true_abstains: falseRoutes,
      exact_plan: exactPlan,
    },
    routed_evidence_request_recall: safeRate(correctFirst, goldRouted),
    routed_first_family_precision: safeRate(correctFirst, predictedRouted),
    false_route_rate_on_true_abstains: safeRate(falseRoutes, goldAbstain),
    gold_abstention_recall: safeRate(goldAbstain - falseRoutes, goldAbstain),
    exact_plan_rate: safeRate(exactPlan, rows.length),
    macro_first_family_recall: macroRecall,
    per_family: perFamily,
  };
}

function isExactPlan(row, prediction) {
  return sameRoute(row.gold_route, prediction.predicted_route)
    && (row.gold_route.length === 0 || prediction.complete === true);
}

function subsetMetrics(rows, predictions, predicate) {
  const selectedRows = [];
  const selectedPredictions = [];
  rows.forEach((row, index) => {
    if (predicate(row)) {
      selectedRows.push(row);
      selectedPredictions.push(predictions[index]);
    }
  });
  return selectedRows.length ? measureCalibration(selectedRows, selectedPredictions) : null;
}

function groupedMetrics(rows, predictions, groups) {
  return Object.fromEntries(Object.entries(groups).map(([name, predicate]) => [name, subsetMetrics(rows, predictions, predicate)]));
}

function buildStratifiedReport(rows, predictions) {
  validateLabeledRows(rows);
  if (!Array.isArray(predictions) || predictions.length !== rows.length) throw new Error('prediction count mismatch');
  const tokenCount = (prompt) => prompt.normalize('NFKC').trim().split(/\s+/u).filter(Boolean).length;
  return {
    definitions: {
      terse: 'normalized whitespace token count <= 8',
      detailed: 'normalized whitespace token count >= 9',
      route_cardinality: 'gold evidence-route cardinality; this is a route-intent proxy, not a general linguistic intent annotation',
      historical_runtime_boundary_proxy: 'gold first family is historical or runtime and label confidence is not high',
      label_agreement: 'optional audit agreement annotation; not_recorded when absent',
    },
    gold_family: groupedMetrics(rows, predictions, {
      abstain: (row) => row.gold_route.length === 0,
      ...Object.fromEntries(FAMILIES.map((family) => [family, (row) => row.gold_route[0] === family])),
    }),
    prompt_detail: groupedMetrics(rows, predictions, {
      terse: (row) => tokenCount(row.prompt) <= 8,
      detailed: (row) => tokenCount(row.prompt) >= 9,
    }),
    route_cardinality: groupedMetrics(rows, predictions, {
      abstain: (row) => row.gold_route.length === 0,
      single: (row) => row.gold_route.length === 1,
      multi: (row) => row.gold_route.length > 1,
    }),
    historical_runtime: groupedMetrics(rows, predictions, {
      historical: (row) => row.gold_route[0] === 'historical',
      runtime: (row) => row.gold_route[0] === 'runtime',
      boundary_proxy: (row) => ['historical', 'runtime'].includes(row.gold_route[0]) && row.label_confidence !== 'high',
    }),
    label_confidence: groupedMetrics(rows, predictions, Object.fromEntries(
      [...CONFIDENCE].sort().map((level) => [level, (row) => row.label_confidence === level]),
    )),
    context_dependency: groupedMetrics(rows, predictions, Object.fromEntries(
      [...DEPENDENCY].sort().map((level) => [level, (row) => row.context_dependency === level]),
    )),
    label_agreement: groupedMetrics(rows, predictions, {
      unanimous: (row) => row.label_agreement === 'unanimous',
      disputed: (row) => row.label_agreement === 'disputed',
      not_recorded: (row) => !['unanimous', 'disputed'].includes(row.label_agreement),
    }),
  };
}

function buildCoverageRiskTable(candidates) {
  const byCoverage = new Map();
  for (const { metrics } of candidates) {
    const coverage = metrics.counts.predicted_routed;
    const point = {
      predicted_routed: coverage,
      total: metrics.counts.total,
      coverage_rate: safeRate(coverage, metrics.counts.total),
      routed_first_family_precision: metrics.routed_first_family_precision,
      routed_evidence_request_recall: metrics.routed_evidence_request_recall,
      false_route_rate_on_true_abstains: metrics.false_route_rate_on_true_abstains,
    };
    const prior = byCoverage.get(coverage);
    const better = !prior
      || ((point.routed_first_family_precision ?? -1) > (prior.routed_first_family_precision ?? -1))
      || (point.routed_first_family_precision === prior.routed_first_family_precision
        && point.false_route_rate_on_true_abstains < prior.false_route_rate_on_true_abstains)
      || (point.routed_first_family_precision === prior.routed_first_family_precision
        && point.false_route_rate_on_true_abstains === prior.false_route_rate_on_true_abstains
        && point.routed_evidence_request_recall > prior.routed_evidence_request_recall);
    if (better) byCoverage.set(coverage, point);
  }
  return [...byCoverage.values()].sort((left, right) => left.predicted_routed - right.predicted_routed);
}

function canonicalConfig(config) {
  if (Array.isArray(config)) return config.map(canonicalConfig);
  if (config && typeof config === 'object') {
    return Object.fromEntries(Object.keys(config).sort().map((key) => [key, canonicalConfig(config[key])]));
  }
  return config;
}

function rankCandidates(candidates, objective) {
  const minimumPrecision = objective?.constraints?.routed_first_family_precision?.minimum;
  const maximumFalseRoute = objective?.constraints?.false_route_rate_on_true_abstains?.maximum;
  if (!Number.isFinite(minimumPrecision) || !Number.isFinite(maximumFalseRoute)) throw new Error('invalid calibration objective constraints');
  return candidates.filter(({ metrics }) => (
    metrics.counts.predicted_routed > 0
    && metrics.routed_first_family_precision != null
    && metrics.routed_first_family_precision >= minimumPrecision
    && metrics.false_route_rate_on_true_abstains != null
    && metrics.false_route_rate_on_true_abstains <= maximumFalseRoute
  )).sort((left, right) => {
    const a = left.metrics;
    const b = right.metrics;
    return (b.routed_evidence_request_recall - a.routed_evidence_request_recall)
      || ((b.macro_first_family_recall ?? -1) - (a.macro_first_family_recall ?? -1))
      || (a.false_route_rate_on_true_abstains - b.false_route_rate_on_true_abstains)
      || (b.routed_first_family_precision - a.routed_first_family_precision)
      || (b.gold_abstention_recall - a.gold_abstention_recall)
      || JSON.stringify(canonicalConfig(left.config)).localeCompare(JSON.stringify(canonicalConfig(right.config)));
  });
}

module.exports = {
  FAMILIES,
  assertRawFieldsMatch,
  buildCoverageRiskTable,
  buildStratifiedReport,
  canonicalConfig,
  isExactPlan,
  measureCalibration,
  rankCandidates,
  safeRate,
  validateLabeledRows,
};
