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

// Nearest-exemplar classifier over the 4 evidence families + an explicit `abstain`
// class. Returns a family only when the top class is a family AND clears an absolute
// score floor AND beats the runner-up by a margin — otherwise it abstains. This is
// what keeps it from routing everything (the failure mode opposite to tells-only).
async function createSemanticClassifier({ exemplarsPath, threshold = 0.6, margin = 0.03, cacheDir, embedFn = embed }) {
  const raw = YAML.parse(fs.readFileSync(exemplarsPath, 'utf8'));
  if (!raw || !raw.classes) throw new Error(`invalid exemplars policy: ${exemplarsPath}`);
  const version = raw.policy_version || 'exemplars-v0';

  const items = [];
  for (const [cls, phrases] of Object.entries(raw.classes)) {
    for (const p of phrases || []) items.push({ cls, text: String(p) });
  }
  if (!items.length) throw new Error('no exemplars');
  const classes = [...new Set(items.map((i) => i.cls))];

  const key = crypto.createHash('sha256').update(JSON.stringify(items) + version).digest('hex').slice(0, 16);
  const cacheFile = cacheDir ? `${cacheDir}/exemplars-${key}.json` : null;

  let vecs;
  if (cacheFile && fs.existsSync(cacheFile)) {
    vecs = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } else {
    const embs = await embedFn(items.map((i) => i.text));
    vecs = items.map((it, i) => ({ cls: it.cls, v: l2norm(embs[i]) }));
    if (cacheFile) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(vecs));
    }
  }

  async function classify(text) {
    const [e] = await embedFn([text]);
    const q = l2norm(e);
    const best = Object.fromEntries(classes.map((c) => [c, -1]));
    for (const ex of vecs) {
      const s = dot(q, ex.v);
      if (s > best[ex.cls]) best[ex.cls] = s;
    }
    const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
    const [topCls, topScore] = ranked[0];
    const secondScore = ranked[1] ? ranked[1][1] : -1;
    const mgn = topScore - secondScore;
    let family = topCls === 'abstain' ? null : topCls;
    let reason = 'semantic';
    if (topCls === 'abstain') reason = 'abstain-class';
    else if (topScore < threshold) { family = null; reason = 'below-threshold'; }
    else if (mgn < margin) { family = null; reason = 'low-margin'; }
    return { family, score: Number(topScore.toFixed(4)), margin: Number(mgn.toFixed(4)), reason, scores: best };
  }

  return { classify, version, classes, threshold, margin };
}

module.exports = { createSemanticClassifier, l2norm, dot };
