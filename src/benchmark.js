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

function scoreRoutes(rows) {
  let firstRouteCorrect = 0;
  let routedCases = 0;
  let fullPlanCorrect = 0;
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
    }
    if (arraysEqual(gold, predicted) && (gold.length === 0 || row.predicted_complete !== false)) fullPlanCorrect += 1;
    if (predicted.length === 0) abstained += 1;
    if (gold.length > 1) {
      multiIntentCases += 1;
      multiIntentFamiliesTotal += gold.length;
      multiIntentFamiliesRecalled += gold.filter((family) => predicted.includes(family)).length;
    }
  }

  return {
    sample_size: rows.length,
    routed_cases: routedCases,
    first_route_correct: firstRouteCorrect,
    full_plan_correct: fullPlanCorrect,
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

  const misses = result.rows.filter((row) => (
    !arraysEqual(row.gold_route, row.predicted_route)
    || (row.gold_route.length > 0 && row.predicted_complete === false)
  ));
  console.log(`misses: ${misses.length}`);
  for (const miss of misses) {
    const completeness = miss.predicted_complete === false ? ` complete=false unmatched=${JSON.stringify(miss.unmatched_clauses)}` : '';
    console.log(`  ${miss.id}: gold=${JSON.stringify(miss.gold_route)} predicted=${JSON.stringify(miss.predicted_route)}${completeness}`);
  }
}

function runBenchmark(rootDir) {
  const planner = createPlanner({
    tellsPath: path.join(rootDir, 'policy', 'tells.yaml'),
    routesPath: path.join(rootDir, 'policy', 'routes.yaml'),
  });
  const dev = evaluateCorpus(path.join(rootDir, 'bench', 'dev-corpus.jsonl'), planner);
  const evaluation = evaluateCorpus(path.join(rootDir, 'bench', 'eval-corpus.jsonl'), planner);
  const satisfactionRows = readJsonl(path.join(rootDir, 'bench', 'satisfaction-cases.jsonl')).map((row) => ({
    ...row,
    actual: evaluateSatisfaction(row.satisfaction, row.simulated_result),
  }));
  const satisfaction = scoreSatisfaction(satisfactionRows);

  printRouteReport('development corpus', dev);
  printRouteReport('frozen evaluation corpus', evaluation);
  console.log(`\nSATISFACTION SIMULATION — SAMPLE SIZE: N=${satisfaction.sample_size}`);
  console.log(`exact outcomes: ${satisfaction.correct}/${satisfaction.sample_size}`);
  console.log(`gate-gaming bypasses: ${satisfaction.gate_gaming_bypasses}/${satisfaction.gate_gaming_cases}`);
  console.log(`freshness rejections: ${satisfaction.freshness_rejections}/${satisfaction.freshness_cases}`);
  console.log(`false blocks: ${satisfaction.false_blocks}/${satisfaction.legitimate_cases}`);
  for (const id of ['sat-empty-gaming', 'sat-irrelevant', 'sat-ritual-emptyargs']) {
    const row = satisfactionRows.find((candidate) => candidate.id === id);
    console.log(`${id} satisfies need: ${row?.actual.satisfied ? 'YES' : 'NO'}`);
  }

  return { dev, evaluation, satisfaction, satisfactionRows };
}

module.exports = { evaluateCorpus, readJsonl, runBenchmark, scoreRoutes, scoreSatisfaction };
