'use strict';

// Measure the LLM classifier on the CALIBRATION set (dev — never Eval-2), first-family
// only (single-clause routing), vs the gold labels. Compares to the deterministic gate.
//   node scripts/bench-llm-calibration.js
const path = require('node:path');
const fs = require('node:fs');
const { createLLMClassifier } = require('../src/llm-classifier');
const { embedAvailable } = require('../src/embed');

const ROOT = path.join(__dirname, '..');
const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

(async () => {
  if (!(await embedAvailable())) { console.error('Ollama not reachable'); process.exit(2); }
  const rows = readJsonl(path.join(ROOT, 'bench', 'real-prompts-calibration-labeled.jsonl'))
    .map((r) => ({ id: r.id, prompt: r.prompt, gold: (r.gold_route || []) }));
  const clf = await createLLMClassifier({});

  const routedGold = rows.filter((r) => r.gold.length);
  const abstainGold = rows.filter((r) => !r.gold.length);
  let firstOk = 0, routedCount = 0, falseRoute = 0;
  const conf = {};
  let done = 0;
  for (const r of rows) {
    const v = await clf.classify(r.prompt);
    const pred = v.family || 'abstain';
    const gold = r.gold.length ? r.gold[0] : 'abstain';
    conf[`${gold}->${pred}`] = (conf[`${gold}->${pred}`] || 0) + 1;
    if (r.gold.length) { if (v.family) { routedCount++; if (v.family === r.gold[0]) firstOk++; } }
    else if (v.family) falseRoute++;
    if (++done % 40 === 0) process.stderr.write(`  ${done}/${rows.length}\n`);
  }
  const n = rows.length;
  console.log(`\nLLM classifier on CALIBRATION (dev, N=${n}; routed-gold=${routedGold.length}, abstain-gold=${abstainGold.length})`);
  console.log(`  routed evidence-cases: ${routedCount}/${routedGold.length}`);
  console.log(`  first-family correct (of routed-gold): ${firstOk}/${routedGold.length} = ${(100 * firstOk / routedGold.length).toFixed(1)}%`);
  console.log(`  routed precision (correct of routed): ${routedCount ? (100 * firstOk / routedCount).toFixed(1) : '-'}%`);
  console.log(`  false-routes on true-abstains: ${falseRoute}/${abstainGold.length}  → abstain-recall ${(100 * (abstainGold.length - falseRoute) / abstainGold.length).toFixed(1)}%`);
  console.log(`\n  vs deterministic gate (Dae's lock): first-family 4/76 routed-recall = 5.26%, abstain-recall 100%`);
  console.log(`\n  confusion gold->pred (top):`);
  Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
})();
