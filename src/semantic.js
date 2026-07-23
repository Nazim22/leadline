'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { embed } = require('./embed');

function l2norm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const FAMILIES = ['historical', 'structural', 'repository', 'runtime'];

// Open-set gating (Dae, Stage 2.1): argmax over the FOUR evidence families, then a
// deterministic route gate decides route-vs-abstain. `abstain` is NOT a competing
// argmax class — it is a heterogeneous complement set, so its exemplars are used only
// as an optional veto/calibration signal. This fixes the failure where generic abstain
// exemplars swallowed terse routing prompts.
async function createSemanticClassifier({
  exemplarsPath,
  floors = 0.55,          // number (global) or per-family map
  margins = 0.02,         // number (global) or per-family map
  topk = 5,
  agreeFrac = 0.6,        // top-k neighborhood agreement can rescue a low-margin case
  abstainVetoMargin = null, // null = off; else veto if abstainScore - s1 >= this
  cacheDir,
  embedFn = embed,
} = {}) {
  const raw = YAML.parse(fs.readFileSync(exemplarsPath, 'utf8'));
  if (!raw || !raw.classes) throw new Error(`invalid exemplars policy: ${exemplarsPath}`);
  const version = raw.policy_version || 'exemplars-v0';

  const items = [];
  for (const [cls, phrases] of Object.entries(raw.classes)) {
    for (const p of phrases || []) items.push({ cls, text: String(p) });
  }
  if (!items.length) throw new Error('no exemplars');

  const key = crypto.createHash('sha256').update(JSON.stringify(items) + version).digest('hex').slice(0, 16);
  const cacheFile = cacheDir ? `${cacheDir}/exemplars-${key}.json` : null;
  let vecs;
  if (cacheFile && fs.existsSync(cacheFile)) {
    vecs = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } else {
    const embs = await embedFn(items.map((i) => i.text));
    vecs = items.map((it, i) => ({ cls: it.cls, v: l2norm(embs[i]) }));
    if (cacheFile) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(vecs)); }
  }
  const floorFor = (f) => (typeof floors === 'number' ? floors : (floors[f] ?? 0.55));
  const marginFor = (f) => (typeof margins === 'number' ? margins : (margins[f] ?? 0.02));

  async function classify(text) {
    const [e] = await embedFn([text]);
    const q = l2norm(e);
    const famBest = Object.fromEntries(FAMILIES.map((f) => [f, -1]));
    const famSims = []; // {cls, s} for family exemplars only
    let abstainBest = -1;
    for (const ex of vecs) {
      const s = dot(q, ex.v);
      if (ex.cls === 'abstain') { if (s > abstainBest) abstainBest = s; continue; }
      if (s > famBest[ex.cls]) famBest[ex.cls] = s;
      famSims.push({ cls: ex.cls, s });
    }
    const ranked = FAMILIES.map((f) => [f, famBest[f]]).sort((a, b) => b[1] - a[1]);
    const [fam1, s1] = ranked[0];
    const [fam2, s2] = ranked[1];
    const familyMargin = +(s1 - s2).toFixed(4);
    // top-k neighborhood agreement
    const topKNbrs = famSims.sort((a, b) => b.s - a.s).slice(0, topk);
    const agree = topKNbrs.length ? topKNbrs.filter((n) => n.cls === fam1).length / topKNbrs.length : 0;

    let routeFamily = fam1;
    let routeGate = 'route';
    let abstainReason = null;
    if (s1 < floorFor(fam1)) {
      routeFamily = null; routeGate = 'abstain'; abstainReason = 'below_family_floor';
    } else if (familyMargin < marginFor(fam1) && agree < agreeFrac) {
      routeFamily = null; routeGate = 'abstain'; abstainReason = 'ambiguous_family_margin';
    } else if (abstainVetoMargin != null && abstainBest - s1 >= abstainVetoMargin) {
      routeFamily = null; routeGate = 'abstain'; abstainReason = 'abstain_veto';
    }

    return {
      family: routeFamily,
      score: +s1.toFixed(4),
      candidate_family: fam1,
      family_score: +s1.toFixed(4),
      runner_up: fam2,
      family_margin: familyMargin,
      abstain_score: +abstainBest.toFixed(4),
      topk_agreement: +agree.toFixed(3),
      route_gate: routeGate,
      abstain_reason: abstainReason,
      top2: [fam1, fam2],
    };
  }

  return { classify, version, families: FAMILIES, floors, margins, topk, agreeFrac, abstainVetoMargin };
}

module.exports = { createSemanticClassifier, l2norm, dot, FAMILIES };
