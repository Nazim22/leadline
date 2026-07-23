#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPlanner } = require('../src/planner');
const { createSemanticClassifierFromLock } = require('../src/semantic');
const { getEmbedModelIdentity } = require('../src/embed');
const {
  assertRawFieldsMatch,
  buildStratifiedReport,
  isExactPlan,
  measureCalibration,
  validateLabeledRows,
} = require('../src/calibration');

const ROOT = path.join(__dirname, '..');
const RAW_PATH = path.join(ROOT, 'bench', 'real-prompts-eval2.jsonl');
const LABELED_PATH = path.join(ROOT, 'bench', 'real-prompts-eval2-labeled.jsonl');
const AGREEMENT_PATH = path.join(ROOT, 'bench', 'real-prompts-eval2-label-agreement.json');
const LOCK_PATH = path.join(ROOT, 'policy', 'semantic-gate.lock.json');
const EXEMPLARS_PATH = path.join(ROOT, 'policy', 'exemplars.yaml');
const TELLS_PATH = path.join(ROOT, 'policy', 'tells.yaml');
const ROUTES_PATH = path.join(ROOT, 'policy', 'routes.yaml');
const OUTPUT_DIR = path.join(ROOT, 'bench', 'results', 'eval2-v1');
const EXECUTION_MARKER = path.join(ROOT, 'bench', 'results', '.eval2-v1-execution.json');
const PRIMARY_EXCLUSION = 'eval2-000112';
const EXPECTED = Object.freeze({
  raw_sha256: '12ed3eab15dbefa1a47b35965a2305da478d486ba819a42ddb162f409fe00471',
  labeled_sha256: 'd6ce98a402a662efd3c7e5a4c458f82489e0add7e3ae30885e679df4eb4af367',
  agreement_sha256: '268094f2265e1be08267ab4bd14142598aaac98167e8bcfa20632d566579d6c0',
  lock_sha256: 'f938561ffdc327f2040097cd8d3acb92dc5a07824d0e1756ba4e81826922f6d4',
  inclusive_n: 200,
  primary_n: 199,
});

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: options.encoding,
    maxBuffer: 10 * 1024 * 1024,
    stdio: options.stdio,
  });
}

function assertCleanCommittedInputs(files) {
  const changes = git(['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (changes) throw new Error('tracked working tree is dirty; commit evaluation code and sealed gold before execution');
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`evaluation input must be inside repository: ${file}`);
    }
    try {
      git(['ls-files', '--error-unmatch', '--', relative], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      throw new Error(`evaluation input is not tracked: ${relative}`);
    }
    if (!git(['show', `HEAD:${relative}`]).equals(fs.readFileSync(file))) {
      throw new Error(`evaluation input differs from HEAD: ${relative}`);
    }
  }
  return git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function historyRuntimeConfusion(rows, predictions) {
  const result = {
    historical_gold_predicted_runtime: 0,
    runtime_gold_predicted_historical: 0,
    historical_or_runtime_gold: 0,
  };
  rows.forEach((row, index) => {
    const gold = row.gold_route[0] || null;
    const predicted = predictions[index].predicted_route[0] || null;
    if (gold === 'historical' || gold === 'runtime') result.historical_or_runtime_gold += 1;
    if (gold === 'historical' && predicted === 'runtime') result.historical_gold_predicted_runtime += 1;
    if (gold === 'runtime' && predicted === 'historical') result.runtime_gold_predicted_historical += 1;
  });
  return result;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('this sealed evaluator accepts no arguments');
  if (fs.existsSync(EXECUTION_MARKER) || fs.existsSync(OUTPUT_DIR)) {
    throw new Error('Eval-2 execution marker/output already exists; refusing a second execution');
  }

  const sourceRevision = assertCleanCommittedInputs([
    RAW_PATH, LABELED_PATH, AGREEMENT_PATH, LOCK_PATH, EXEMPLARS_PATH,
    TELLS_PATH, ROUTES_PATH, __filename,
  ]);
  const actualHashes = {
    raw_sha256: sha256(RAW_PATH),
    labeled_sha256: sha256(LABELED_PATH),
    agreement_sha256: sha256(AGREEMENT_PATH),
    lock_sha256: sha256(LOCK_PATH),
  };
  for (const [field, expected] of Object.entries(EXPECTED)) {
    if (field.endsWith('_sha256') && actualHashes[field] !== expected) {
      throw new Error(`sealed ${field} mismatch`);
    }
  }
  const agreement = JSON.parse(fs.readFileSync(AGREEMENT_PATH, 'utf8'));
  if (agreement.status !== 'adjudicated-gold-sealed-before-gate'
      || agreement.gate_opened !== false
      || agreement.raw_eval2_sha256 !== EXPECTED.raw_sha256
      || agreement.adjudicated_gold_sha256 !== EXPECTED.labeled_sha256
      || agreement.primary_n !== EXPECTED.primary_n
      || agreement.inclusive_n !== EXPECTED.inclusive_n
      || JSON.stringify(agreement.primary_exclusion) !== JSON.stringify([PRIMARY_EXCLUSION])) {
    throw new Error('sealed agreement manifest does not match the frozen Eval-2 protocol');
  }
  const rawRows = readJsonl(RAW_PATH);
  const rows = validateLabeledRows(readJsonl(LABELED_PATH));
  assertRawFieldsMatch(rawRows, rows);
  if (rows.length !== EXPECTED.inclusive_n) throw new Error('Eval-2 must contain exactly 200 rows');
  if (!rows.some((row) => row.id === PRIMARY_EXCLUSION)) throw new Error('predeclared exclusion is missing');

  const modelIdentity = await getEmbedModelIdentity();
  const locked = await createSemanticClassifierFromLock({
    lockPath: LOCK_PATH,
    exemplarsPath: EXEMPLARS_PATH,
    embedModelIdentity: modelIdentity,
    cacheDir: path.join(ROOT, 'bench', '.cache'),
  });
  let semanticCalls = 0;
  const classifier = {
    fingerprint: locked.fingerprint,
    classify: async (text) => {
      semanticCalls += 1;
      return locked.classify(text);
    },
  };
  const planner = createPlanner({ tellsPath: TELLS_PATH, routesPath: ROUTES_PATH, semanticClassifier: classifier });

  const startedReceipt = {
    schema_version: 1,
    status: 'active',
    started_at: new Date().toISOString(),
    source_revision: sourceRevision,
    raw_sha256: actualHashes.raw_sha256,
    labeled_gold_sha256: actualHashes.labeled_sha256,
    lock_sha256: actualHashes.lock_sha256,
    embed_model_identity: modelIdentity,
    planned_rows: rows.length,
    primary_exclusions: [PRIMARY_EXCLUSION],
  };
  fs.writeFileSync(EXECUTION_MARKER, `${JSON.stringify(startedReceipt, null, 2)}\n`, { flag: 'wx' });
  fs.mkdirSync(OUTPUT_DIR, { recursive: false });
  const receiptPath = path.join(OUTPUT_DIR, 'execution-receipt.json');
  writeJson(receiptPath, startedReceipt);

  const predictions = [];
  for (const row of rows) {
    const contract = await planner.planSemantic(row.prompt, { turnId: row.id });
    predictions.push({
      id: row.id,
      predicted_route: contract.steps.map((step) => step.need),
      complete: contract.complete,
      abstain_reason: contract.abstain_reason,
      classified_by: contract.steps.map((step) => step.classified_by),
    });
  }

  const primaryIndexes = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.id !== PRIMARY_EXCLUSION);
  const primaryRows = primaryIndexes.map(({ row }) => row);
  const primaryPredictions = primaryIndexes.map(({ index }) => predictions[index]);
  if (primaryRows.length !== EXPECTED.primary_n) throw new Error('primary Eval-2 view must contain exactly 199 rows');
  const inclusiveMetrics = measureCalibration(rows, predictions);
  const primaryMetrics = measureCalibration(primaryRows, primaryPredictions);
  const report = {
    schema_version: 1,
    status: 'complete',
    source_revision: sourceRevision,
    lock_sha256: actualHashes.lock_sha256,
    raw_sha256: actualHashes.raw_sha256,
    labeled_gold_sha256: actualHashes.labeled_sha256,
    embed_model_identity: modelIdentity,
    classifier_fingerprint: locked.fingerprint,
    planner_executions: rows.length,
    semantic_classifier_calls: semanticCalls,
    primary: {
      n: primaryRows.length,
      excluded_ids: [PRIMARY_EXCLUSION],
      metrics: primaryMetrics,
      strata: buildStratifiedReport(primaryRows, primaryPredictions),
      historical_runtime_confusion: historyRuntimeConfusion(primaryRows, primaryPredictions),
    },
    inclusive_sensitivity: {
      n: rows.length,
      metrics: inclusiveMetrics,
      strata: buildStratifiedReport(rows, predictions),
      historical_runtime_confusion: historyRuntimeConfusion(rows, predictions),
    },
  };
  const combined = rows.map((row, index) => ({ ...row, ...predictions[index] }));
  const misses = combined.filter((row, index) => !isExactPlan(row, predictions[index]));
  writeJsonl(path.join(OUTPUT_DIR, 'predictions.jsonl'), combined);
  writeJsonl(path.join(OUTPUT_DIR, 'misses.jsonl'), misses);
  writeJson(path.join(OUTPUT_DIR, 'report.json'), report);
  const completedReceipt = {
    schema_version: 1,
    status: 'complete',
    completed_at: new Date().toISOString(),
    source_revision: sourceRevision,
    raw_sha256: report.raw_sha256,
    labeled_gold_sha256: report.labeled_gold_sha256,
    lock_sha256: report.lock_sha256,
    embed_model_identity: modelIdentity,
    classifier_fingerprint: locked.fingerprint,
    planner_executions: rows.length,
    semantic_classifier_calls: semanticCalls,
    primary_exclusions: [PRIMARY_EXCLUSION],
  };
  writeJson(receiptPath, completedReceipt);
  writeJson(EXECUTION_MARKER, completedReceipt);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
