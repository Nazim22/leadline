'use strict';

// Stage-2 semantic benchmark. Tunes (threshold, margin) on the DEV corpus ONLY,
// then evaluates ONCE on a frozen labeled corpus. Never tunes against the eval set.
//   node scripts/bench-semantic.js --labeled <path-to-labeled.jsonl>
const path = require('node:path');
const fs = require('node:fs');
const { createPlanner } = require('../src/planner');
const { createSemanticClassifier } = require('../src/semantic');
const { embedAvailable } = require('../src/embed');

const ROOT = path.join(__dirname, '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const LABELED = arg('--labeled', path.join(ROOT, 'bench', 'real-prompts-dae-labeled.jsonl'));

const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const route = (contract) => contract.steps.map((s) => s.need);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const ff = (r) => (r.length ? r[0] : 'abstain');

function score(rows, preds) {
  const routedGold = rows.filter((r) => (r.gold_route || []).length);
  let firstOk = 0, routedExact = 0;
  for (const r of routedGold) {
    const p = preds[r.id];
    if (p.length && p[0] === r.gold_route[0]) firstOk++;
    if (eq(p, r.gold_route)) routedExact++;
  }
  let exactAll = 0, abstainGold = 0, abstainGoldOk = 0, predAbstain = 0;
  for (const r of rows) {
    const g = r.gold_route || [];
    const p = preds[r.id];
    if (eq(p, g)) exactAll++;
    if (!g.length) { abstainGold++; if (!p.length) abstainGoldOk++; }
    if (!p.length) predAbstain++;
  }
  return {
    routed_first_route: { correct: firstOk, total: routedGold.length, rate: routedGold.length ? +(firstOk / routedGold.length).toFixed(4) : null },
    routed_exact_plan: { correct: routedExact, total: routedGold.length, rate: routedGold.length ? +(routedExact / routedGold.length).toFixed(4) : null },
    full_plan_exact_all: { correct: exactAll, total: rows.length, rate: +(exactAll / rows.length).toFixed(4) },
    gold_abstention_recall: { correct: abstainGoldOk, total: abstainGold, rate: abstainGold ? +(abstainGoldOk / abstainGold).toFixed(4) : null },
    predicted_abstention_rate: { abstained: predAbstain, total: rows.length, rate: +(predAbstain / rows.length).toFixed(4) },
  };
}

async function predictAll(planner, rows, semantic) {
  const out = {};
  for (const r of rows) out[r.id] = route(semantic ? await planner.planSemantic(r.prompt) : planner.plan(r.prompt));
  return out;
}

(async () => {
  if (!(await embedAvailable())) { console.error('Ollama/bge-m3 not reachable — start it first.'); process.exit(2); }

  const dev = readJsonl(path.join(ROOT, 'bench', 'dev-corpus.jsonl')).map((r) => ({ id: r.id, prompt: r.prompt, gold_route: r.gold_route }));
  const real = readJsonl(LABELED).map((r) => ({ id: r.id, prompt: r.prompt, gold_route: r.gold_route || [] }));

  // --- TUNE on dev only ---
  const grid = [];
  for (const threshold of [0.5, 0.55, 0.6, 0.65, 0.7]) {
    for (const margin of [0, 0.02, 0.05]) {
      const sc = await createSemanticClassifier({ exemplarsPath: path.join(ROOT, 'policy', 'exemplars.yaml'), floors: threshold, margins: margin, cacheDir: path.join(ROOT, 'bench', '.cache') });
      const p = createPlanner({ tellsPath: path.join(ROOT, 'policy', 'tells.yaml'), routesPath: path.join(ROOT, 'policy', 'routes.yaml'), semanticClassifier: sc });
      const preds = await predictAll(p, dev, true);
      const m = score(dev, preds);
      grid.push({ threshold, margin, dev_first: m.routed_first_route.rate, dev_exact_all: m.full_plan_exact_all.rate });
    }
  }
  grid.sort((a, b) => (b.dev_exact_all - a.dev_exact_all) || (b.dev_first - a.dev_first) || (b.threshold - a.threshold));
  const best = grid[0];
  console.log(`TUNED on dev (N=${dev.length}): threshold=${best.threshold} margin=${best.margin} (dev exact-all=${best.dev_exact_all}, dev first-route=${best.dev_first})\n`);

  // --- EVAL once on frozen real corpus ---
  const tellsOnly = createPlanner({ tellsPath: path.join(ROOT, 'policy', 'tells.yaml'), routesPath: path.join(ROOT, 'policy', 'routes.yaml') });
  const scReal = await createSemanticClassifier({ exemplarsPath: path.join(ROOT, 'policy', 'exemplars.yaml'), floors: best.threshold, margins: best.margin, cacheDir: path.join(ROOT, 'bench', '.cache') });
  const withSemantic = createPlanner({ tellsPath: path.join(ROOT, 'policy', 'tells.yaml'), routesPath: path.join(ROOT, 'policy', 'routes.yaml'), semanticClassifier: scReal });

  const base = score(real, await predictAll(tellsOnly, real, false));
  const sem = score(real, await predictAll(withSemantic, real, true));

  const line = (label, m) => `  ${label.padEnd(26)} first-route(routed)=${String(m.routed_first_route.rate).padEnd(6)} exact-all=${String(m.full_plan_exact_all.rate).padEnd(6)} abstain-recall=${String(m.gold_abstention_recall.rate).padEnd(6)} pred-abstain=${m.predicted_abstention_rate.rate}`;
  console.log(`FROZEN REAL EVAL (N=${real.length}, routed gold=${real.filter((r) => r.gold_route.length).length})`);
  console.log(line('tells-only (V0)', base));
  console.log(line('tells + semantic (Stage-2)', sem));
  console.log(`\nrouted first-route: ${base.routed_first_route.correct} -> ${sem.routed_first_route.correct} of ${sem.routed_first_route.total}`);
})();
