'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createPlanner } = require('./planner');
const { evaluateSatisfaction } = require('./satisfaction');

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recalledFamilyOccurrences(gold, predicted) {
  const remaining = new Map();
  for (const family of predicted) remaining.set(family, (remaining.get(family) || 0) + 1);
  let recalled = 0;
  for (const family of gold) {
    const count = remaining.get(family) || 0;
    if (count > 0) {
      recalled += 1;
      remaining.set(family, count - 1);
    }
  }
  return recalled;
}

function isRouteMiss(row) {
  return !arraysEqual(row.gold_route, row.predicted_route)
    || (row.gold_route.length > 0 && row.predicted_complete === false);
}

function countedRows(counts) {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function buildRouteDiagnostics(rows) {
  const confusions = new Map();
  const distribution = new Map();

  for (const row of rows) {
    const gold = row.gold_route[0] || '<abstain>';
    const predicted = row.predicted_route[0] || '<abstain>';
    distribution.set(gold, (distribution.get(gold) || 0) + 1);
    if (gold !== predicted) {
      const key = `${gold}\0${predicted}`;
      confusions.set(key, (confusions.get(key) || 0) + 1);
    }
  }

  return {
    first_route_confusions: countedRows(confusions).map(({ key, count }) => {
      const [gold, predicted] = key.split('\0');
      return { gold, predicted, count };
    }),
    gold_route_distribution: countedRows(distribution).map(({ key, count }) => ({ route: key, count })),
    misses: rows.filter(isRouteMiss),
  };
}

function scoreRoutes(rows) {
  let firstRouteCorrect = 0;
  let routedCases = 0;
  let routedFullPlanCorrect = 0;
  let fullPlanCorrect = 0;
  let goldAbstainCases = 0;
  let correctAbstentions = 0;
  let abstained = 0;
  let multiIntentCases = 0;
  let multiIntentFamiliesRecalled = 0;
  let multiIntentFamiliesTotal = 0;

  for (const row of rows) {
    const gold = row.gold_route;
    const predicted = row.predicted_route;
    const goldFirst = gold[0] ?? null;
    const predictedFirst = predicted[0] ?? null;
    if (gold.length > 0) {
      routedCases += 1;
      if (goldFirst === predictedFirst) firstRouteCorrect += 1;
    } else {
      goldAbstainCases += 1;
      if (predicted.length === 0) correctAbstentions += 1;
    }
    const exactPlan = arraysEqual(gold, predicted) && (gold.length === 0 || row.predicted_complete !== false);
    if (exactPlan) {
      fullPlanCorrect += 1;
      if (gold.length > 0) routedFullPlanCorrect += 1;
    }
    if (predicted.length === 0) abstained += 1;
    if (gold.length > 1) {
      multiIntentCases += 1;
      multiIntentFamiliesTotal += gold.length;
      multiIntentFamiliesRecalled += recalledFamilyOccurrences(gold, predicted);
    }
  }

  return {
    sample_size: rows.length,
    routed_cases: routedCases,
    first_route_correct: firstRouteCorrect,
    routed_full_plan_correct: routedFullPlanCorrect,
    full_plan_correct: fullPlanCorrect,
    gold_abstain_cases: goldAbstainCases,
    correct_abstentions: correctAbstentions,
    abstained,
    multi_intent_cases: multiIntentCases,
    multi_intent_families_recalled: multiIntentFamiliesRecalled,
    multi_intent_families_total: multiIntentFamiliesTotal,
  };
}

function scoreSatisfaction(rows) {
  let correct = 0;
  let gateGamingCases = 0;
  let gateGamingBypasses = 0;
  let freshnessCases = 0;
  let freshnessRejections = 0;
  let legitimateCases = 0;
  let falseBlocks = 0;

  for (const row of rows) {
    if (row.actual.satisfied === row.expected.satisfied && row.actual.failure === row.expected.failure) correct += 1;
    if (row.expected.satisfied) {
      legitimateCases += 1;
      if (!row.actual.satisfied) falseBlocks += 1;
    } else if (['empty', 'irrelevant'].includes(row.expected.failure)) {
      gateGamingCases += 1;
      if (row.actual.satisfied) gateGamingBypasses += 1;
    } else if (row.expected.failure === 'stale') {
      freshnessCases += 1;
      if (!row.actual.satisfied && row.actual.failure === 'stale') freshnessRejections += 1;
    }
  }

  return {
    sample_size: rows.length,
    correct,
    gate_gaming_cases: gateGamingCases,
    gate_gaming_bypasses: gateGamingBypasses,
    freshness_cases: freshnessCases,
    freshness_rejections: freshnessRejections,
    legitimate_cases: legitimateCases,
    false_blocks: falseBlocks,
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function countField(rows, field) {
  return rows.reduce((counts, row) => {
    const value = row[field] || '<missing>';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function buildRealReport(evaluation, metadata) {
  const metric = evaluation.metrics;
  return {
    schema_version: 1,
    metadata: { ...metadata },
    metrics: {
      sample_size: metric.sample_size,
      first_route_accuracy: {
        correct: metric.first_route_correct,
        total: metric.routed_cases,
        rate: ratio(metric.first_route_correct, metric.routed_cases),
      },
      full_plan_exact_match: {
        correct: metric.full_plan_correct,
        total: metric.sample_size,
        rate: ratio(metric.full_plan_correct, metric.sample_size),
      },
      routed_full_plan_exact_match: {
        correct: metric.routed_full_plan_correct,
        total: metric.routed_cases,
        rate: ratio(metric.routed_full_plan_correct, metric.routed_cases),
      },
      gold_abstention_recall: {
        correct: metric.correct_abstentions,
        total: metric.gold_abstain_cases,
        rate: ratio(metric.correct_abstentions, metric.gold_abstain_cases),
      },
      abstention_rate: {
        abstained: metric.abstained,
        total: metric.sample_size,
        rate: ratio(metric.abstained, metric.sample_size),
      },
      multi_intent_recall: {
        recalled: metric.multi_intent_families_recalled,
        total: metric.multi_intent_families_total,
        rate: ratio(metric.multi_intent_families_recalled, metric.multi_intent_families_total),
        cases: metric.multi_intent_cases,
      },
    },
    annotation_distribution: {
      confidence: countField(evaluation.rows, 'label_confidence'),
      context_dependency: countField(evaluation.rows, 'context_dependency'),
    },
    diagnostics: buildRouteDiagnostics(evaluation.rows),
  };
}

function evaluateCorpus(filePath, planner) {
  const rows = readJsonl(filePath);
  let latencyMs = 0;
  const scored = rows.map((row) => {
    const start = performance.now();
    const contract = planner.plan(row.prompt, { turnId: row.id });
    latencyMs += performance.now() - start;
    return {
      ...row,
      predicted_route: contract.steps.map((step) => step.need),
      predicted_complete: contract.complete,
      unmatched_clauses: contract.unmatched_clauses,
    };
  });
  return { rows: scored, metrics: { ...scoreRoutes(scored), latency_ms: latencyMs } };
}

function formatPercent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function printRouteReport(label, result) {
  const metric = result.metrics;
  console.log(`\n${label.toUpperCase()} — SAMPLE SIZE: N=${metric.sample_size}`);
  console.log(`first-route accuracy: ${formatPercent(ratio(metric.first_route_correct, metric.routed_cases))} (N=${metric.routed_cases} routed)`);
  console.log(`full-plan exact-match: ${formatPercent(ratio(metric.full_plan_correct, metric.sample_size))}`);
  console.log(`abstention rate: ${formatPercent(ratio(metric.abstained, metric.sample_size))}`);
  console.log(`multi-intent recall: ${formatPercent(ratio(metric.multi_intent_families_recalled, metric.multi_intent_families_total))} (${metric.multi_intent_cases} cases)`);
  console.log(`routing latency: ${metric.latency_ms.toFixed(3)} ms total`);

  const misses = result.rows.filter(isRouteMiss);
  console.log(`misses: ${misses.length}`);
  for (const miss of misses) {
    const completeness = miss.predicted_complete === false ? ` complete=false unmatched=${JSON.stringify(miss.unmatched_clauses)}` : '';
    console.log(`  ${miss.id}: gold=${JSON.stringify(miss.gold_route)} predicted=${JSON.stringify(miss.predicted_route)}${completeness}`);
  }
}

function writeJsonl(filePath, rows) {
  const content = rows.length > 0
    ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
    : '';
  fs.writeFileSync(filePath, content);
}

function runRealCorpus(rootDir, planner) {
  const manifestPath = path.join(rootDir, 'bench', 'real-benchmark-manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const labeledPath = path.join(rootDir, manifest.labeled_file);
  if (!fs.existsSync(labeledPath)) throw new Error(`real benchmark labels missing: ${labeledPath}`);

  const evaluation = evaluateCorpus(labeledPath, planner);
  const report = buildRealReport(evaluation, manifest);
  const resultsDir = path.join(rootDir, manifest.results_dir);
  const prefix = manifest.artifact_prefix || 'dae';
  fs.mkdirSync(resultsDir, { recursive: true });
  writeJsonl(path.join(resultsDir, `${prefix}-predictions.jsonl`), evaluation.rows);
  writeJsonl(path.join(resultsDir, `${prefix}-misses.jsonl`), report.diagnostics.misses);
  fs.writeFileSync(path.join(resultsDir, `${prefix}-report.json`), `${JSON.stringify(report, null, 2)}\n`);

  return { evaluation, report, results_dir: resultsDir };
}

function runBenchmark(rootDir) {
  const planner = createPlanner({
    tellsPath: path.join(rootDir, 'policy', 'tells.yaml'),
    routesPath: path.join(rootDir, 'policy', 'routes.yaml'),
  });
  const dev = evaluateCorpus(path.join(rootDir, 'bench', 'dev-corpus.jsonl'), planner);
  const evaluation = evaluateCorpus(path.join(rootDir, 'bench', 'eval-corpus.jsonl'), planner);
  const real = runRealCorpus(rootDir, planner);
  const satisfactionRows = readJsonl(path.join(rootDir, 'bench', 'satisfaction-cases.jsonl')).map((row) => ({
    ...row,
    actual: evaluateSatisfaction(row.satisfaction, row.simulated_result),
  }));
  const satisfaction = scoreSatisfaction(satisfactionRows);

  printRouteReport('development corpus', dev);
  printRouteReport('frozen evaluation corpus', evaluation);
  if (real) {
    printRouteReport('real frozen evaluation corpus — Dae blind labels', real.evaluation);
    console.log('first-route confusion pairs:');
    if (real.report.diagnostics.first_route_confusions.length === 0) console.log('  none');
    for (const pair of real.report.diagnostics.first_route_confusions) {
      console.log(`  ${pair.gold} -> ${pair.predicted}: ${pair.count}`);
    }
    console.log(`real benchmark artifacts: ${real.results_dir}`);
  }
  console.log(`\nSATISFACTION SIMULATION — SAMPLE SIZE: N=${satisfaction.sample_size}`);
  console.log(`exact outcomes: ${satisfaction.correct}/${satisfaction.sample_size}`);
  console.log(`gate-gaming bypasses: ${satisfaction.gate_gaming_bypasses}/${satisfaction.gate_gaming_cases}`);
  console.log(`freshness rejections: ${satisfaction.freshness_rejections}/${satisfaction.freshness_cases}`);
  console.log(`false blocks: ${satisfaction.false_blocks}/${satisfaction.legitimate_cases}`);
  for (const id of ['sat-empty-gaming', 'sat-irrelevant', 'sat-ritual-emptyargs']) {
    const row = satisfactionRows.find((candidate) => candidate.id === id);
    console.log(`${id} satisfies need: ${row?.actual.satisfied ? 'YES' : 'NO'}`);
  }

  return { dev, evaluation, real, satisfaction, satisfactionRows };
}

module.exports = {
  buildRealReport,
  buildRouteDiagnostics,
  evaluateCorpus,
  readJsonl,
  runBenchmark,
  runRealCorpus,
  scoreRoutes,
  scoreSatisfaction,
};
