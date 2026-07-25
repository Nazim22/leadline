#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPlanner } = require('../src/planner');
const { applySemanticGate, createSemanticClassifier, normalizeText } = require('../src/semantic');
const { getEmbedModelIdentity } = require('../src/embed');
const {
  FAMILIES,
  assertRawFieldsMatch,
  buildCoverageRiskTable,
  buildStratifiedReport,
  canonicalConfig,
  isExactPlan,
  measureCalibration,
  rankCandidates,
  validateLabeledRows,
} = require('../src/calibration');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') || index + 1 >= argv.length) throw new Error(`invalid argument: ${token}`);
    args[token.slice(2)] = argv[++index];
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: options.encoding,
    maxBuffer: 10 * 1024 * 1024,
    stdio: options.stdio,
  });
}

function assertCleanCommittedInputs(paths) {
  const trackedChanges = git(['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (trackedChanges) throw new Error('tracked working tree is dirty; commit calibration code and inputs before running');
  for (const file of paths) {
    const relative = path.relative(ROOT, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`calibration input must be inside repository: ${file}`);
    }
    try {
      git(['ls-files', '--error-unmatch', '--', relative], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      throw new Error(`calibration input is not tracked: ${relative}`);
    }
    const committed = git(['show', `HEAD:${relative}`]);
    const working = fs.readFileSync(file);
    if (!committed.equals(working)) throw new Error(`calibration input differs from HEAD: ${relative}`);
  }
  return git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function plannerOptions(classifier) {
  return {
    tellsPath: path.join(ROOT, 'policy', 'tells.yaml'),
    routesPath: path.join(ROOT, 'policy', 'routes.yaml'),
    semanticClassifier: classifier,
  };
}

function gateConfig(floors, margins, veto, fixed) {
  return {
    floors: canonicalConfig(floors),
    margins: canonicalConfig(margins),
    topk: fixed.topk,
    agreeFrac: fixed.agreement_fraction,
    abstainVetoMargin: veto,
  };
}

function allFamilyMap(value) {
  return Object.fromEntries(FAMILIES.map((family) => [family, value]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const labeledPath = path.resolve(args.labeled || path.join(ROOT, 'bench', 'real-prompts-calibration-labeled.jsonl'));
  const outputDir = path.resolve(args.output || path.join(ROOT, 'bench', 'results', 'calibration-v1'));
  const objectivePath = path.resolve(args.objective || path.join(ROOT, 'policy', 'semantic-calibration-objective.json'));
  const searchPath = path.resolve(args.search || path.join(ROOT, 'policy', 'semantic-calibration-search.json'));
  const exemplarsPath = path.resolve(args.exemplars || path.join(ROOT, 'policy', 'exemplars.yaml'));
  const rawCalibrationPath = path.join(ROOT, 'bench', 'real-prompts-calibration.jsonl');
  const sourceRevision = assertCleanCommittedInputs([
    labeledPath,
    objectivePath,
    searchPath,
    exemplarsPath,
    rawCalibrationPath,
  ]);
  const rows = validateLabeledRows(readJsonl(labeledPath));
  assertRawFieldsMatch(readJsonl(rawCalibrationPath), rows);
  const objective = readJson(objectivePath);
  const search = readJson(searchPath);
  const fixed = search.fixed;
  const modelIdentity = await getEmbedModelIdentity();

  const scorer = await createSemanticClassifier({
    exemplarsPath,
    floors: -1,
    margins: 0,
    topk: fixed.topk,
    agreeFrac: fixed.agreement_fraction,
    abstainVetoMargin: null,
    cacheDir: path.join(ROOT, 'bench', '.cache'),
    embedModelIdentity: modelIdentity,
  });

  const rawScores = new Map();
  const recorder = {
    fingerprint: `score-recorder:${scorer.exemplarFingerprint.slice(0, 16)}`,
    classify: async (text) => {
      const key = normalizeText(text);
      if (!rawScores.has(key)) rawScores.set(key, await scorer.score(key));
      return { family: null, abstain_reason: 'below_family_floor' };
    },
  };
  const recordingPlanner = createPlanner(plannerOptions(recorder));
  for (const row of rows) await recordingPlanner.planSemantic(row.prompt, { turnId: row.id });

  const evaluationCache = new Map();
  async function evaluate(config) {
    const key = JSON.stringify(canonicalConfig(config));
    if (evaluationCache.has(key)) return evaluationCache.get(key);
    const classifier = {
      fingerprint: `calibration-candidate:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
      classify: async (text) => {
        const raw = rawScores.get(normalizeText(text));
        if (!raw) throw new Error('missing precomputed semantic score');
        return applySemanticGate(raw, config);
      },
    };
    const planner = createPlanner(plannerOptions(classifier));
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
    const candidate = { config: canonicalConfig(config), metrics: measureCalibration(rows, predictions), predictions };
    evaluationCache.set(key, candidate);
    return candidate;
  }

  const globalCandidates = [];
  for (const floor of search.grid.family_floors) {
    for (const margin of search.grid.family_margins) {
      for (const veto of search.grid.abstain_veto_margins) {
        globalCandidates.push(await evaluate(gateConfig(allFamilyMap(floor), allFamilyMap(margin), veto, fixed)));
      }
    }
  }
  let ranked = rankCandidates(globalCandidates, objective);
  if (ranked.length === 0) throw new Error('no eligible global calibration configuration; refusing to lock');
  let best = ranked[0];

  for (let pass = 0; pass < search.algorithm.maximum_coordinate_passes; pass += 1) {
    const before = JSON.stringify(best.config);
    for (const family of search.algorithm.family_order) {
      const candidates = [best];
      for (const floor of search.grid.family_floors) {
        for (const margin of search.grid.family_margins) {
          candidates.push(await evaluate(gateConfig(
            { ...best.config.floors, [family]: floor },
            { ...best.config.margins, [family]: margin },
            best.config.abstainVetoMargin,
            fixed,
          )));
        }
      }
      ranked = rankCandidates(candidates, objective);
      if (ranked.length === 0) throw new Error(`coordinate search became infeasible at ${family}`);
      best = ranked[0];
    }
    const vetoCandidates = [best];
    for (const veto of search.grid.abstain_veto_margins) {
      vetoCandidates.push(await evaluate(gateConfig(best.config.floors, best.config.margins, veto, fixed)));
    }
    best = rankCandidates(vetoCandidates, objective)[0];
    if (JSON.stringify(best.config) === before) break;
  }

  const selectedClassifier = await createSemanticClassifier({
    exemplarsPath,
    ...best.config,
    cacheDir: path.join(ROOT, 'bench', '.cache'),
    embedModelIdentity: modelIdentity,
  });
  const lock = {
    schema_version: 1,
    status: 'locked',
    lock_version: 'semantic-gate-v1',
    locked_at: new Date().toISOString(),
    source_revision: sourceRevision,
    classifier_fingerprint: selectedClassifier.fingerprint,
    exemplar_version: selectedClassifier.version,
    exemplar_sha256: sha256(exemplarsPath),
    embed_model_identity: modelIdentity,
    normalization: selectedClassifier.normalizationVersion,
    similarity: selectedClassifier.similarity,
    topk: best.config.topk,
    agreement_fraction: best.config.agreeFrac,
    family_floors: best.config.floors,
    family_margins: best.config.margins,
    abstain_veto_margin: best.config.abstainVetoMargin,
    context_policy: fixed.context_policy,
    objective_version: objective.objective_version,
    objective_sha256: sha256(objectivePath),
    search_version: search.search_version,
    search_sha256: sha256(searchPath),
    calibration_corpus_sha256: sha256(rawCalibrationPath),
    calibration_labels_sha256: sha256(labeledPath),
    calibration_metrics: best.metrics,
    calibration_family_support: Object.fromEntries(FAMILIES.map((family) => [family, best.metrics.per_family[family].gold])),
    evaluated_configurations: evaluationCache.size,
    eval1_used: false,
    eval2_opened: false,
  };
  const evaluatedCandidates = [...evaluationCache.values()];
  const report = {
    schema_version: 1,
    selected: { config: best.config, metrics: best.metrics },
    selected_strata: buildStratifiedReport(rows, best.predictions),
    coverage_risk: buildCoverageRiskTable(evaluatedCandidates),
    global_best: { config: rankCandidates(globalCandidates, objective)[0].config, metrics: rankCandidates(globalCandidates, objective)[0].metrics },
    raw_semantic_clauses: rawScores.size,
    evaluated_configurations: evaluationCache.size,
    objective,
    search,
  };
  const misses = rows.map((row, index) => ({ ...row, ...best.predictions[index] }))
    .filter((row, index) => !isExactPlan(row, best.predictions[index]));

  writeJson(path.join(outputDir, 'semantic-gate.lock.json'), lock);
  writeJson(path.join(outputDir, 'calibration-report.json'), report);
  writeJsonl(path.join(outputDir, 'calibration-predictions.jsonl'), rows.map((row, index) => ({ ...row, ...best.predictions[index] })));
  writeJsonl(path.join(outputDir, 'calibration-misses.jsonl'), misses);
  process.stdout.write(`${JSON.stringify({ lock: path.join(outputDir, 'semantic-gate.lock.json'), metrics: best.metrics, evaluated: evaluationCache.size }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
