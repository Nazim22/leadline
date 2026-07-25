'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { embed } = require('./embed');

const FAMILIES = Object.freeze(['historical', 'structural', 'repository', 'runtime']);
const NORMALIZATION_VERSION = 'nfkc-ws-v1';

function normalizeText(text) {
  if (typeof text !== 'string') throw new TypeError('semantic text must be a string');
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function assertVector(vector, label, expectedDimension = null) {
  if (!Array.isArray(vector) || vector.length === 0) throw new TypeError(`${label} must be a non-empty vector`);
  if (expectedDimension != null && vector.length !== expectedDimension) {
    throw new RangeError(`${label} dimension ${vector.length} != ${expectedDimension}`);
  }
  if (!vector.every(Number.isFinite)) throw new TypeError(`${label} must contain only finite numbers`);
  return vector.length;
}

function l2norm(vector) {
  assertVector(vector, 'embedding');
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  if (!Number.isFinite(sumSquares) || sumSquares === 0) throw new RangeError('embedding norm must be finite and non-zero');
  const norm = Math.sqrt(sumSquares);
  return vector.map((value) => value / norm);
}

function dot(a, b) {
  assertVector(a, 'left vector');
  assertVector(b, 'right vector', a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function validateThresholdSpec(name, value, minimum, maximum) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} must be finite in [${minimum}, ${maximum}]`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a number or per-family map`);
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...FAMILIES].sort())) {
    throw new TypeError(`${name} must define exactly: ${FAMILIES.join(', ')}`);
  }
  for (const family of FAMILIES) validateThresholdSpec(`${name}.${family}`, value[family], minimum, maximum);
}

function validateGateConfig(config) {
  validateThresholdSpec('floors', config.floors, -1, 1);
  validateThresholdSpec('margins', config.margins, 0, 2);
  if (!Number.isInteger(config.topk) || config.topk < 1) throw new RangeError('topk must be a positive integer');
  if (!Number.isFinite(config.agreeFrac) || config.agreeFrac < 0 || config.agreeFrac > 1) {
    throw new RangeError('agreeFrac must be finite in [0, 1]');
  }
  if (config.abstainVetoMargin != null && (!Number.isFinite(config.abstainVetoMargin)
      || config.abstainVetoMargin < -2 || config.abstainVetoMargin > 2)) {
    throw new RangeError('abstainVetoMargin must be null or finite in [-2, 2]');
  }
  return config;
}

function thresholdFor(spec, family) {
  return typeof spec === 'number' ? spec : spec[family];
}

function round(value, places) {
  return Number(value.toFixed(places));
}

function applySemanticGate(raw, config) {
  validateGateConfig(config);
  if (!raw || !FAMILIES.includes(raw.candidate_family) || !FAMILIES.includes(raw.runner_up)) {
    throw new TypeError('invalid semantic score record');
  }
  for (const key of ['family_score', 'runner_up_score', 'topk_agreement']) {
    if (!Number.isFinite(raw[key])) throw new TypeError(`${key} must be finite`);
  }
  if (raw.abstain_score != null && !Number.isFinite(raw.abstain_score)) {
    throw new TypeError('abstain_score must be null or finite');
  }

  const family = raw.candidate_family;
  const margin = raw.family_score - raw.runner_up_score;
  let routed = family;
  let reason = null;
  if (raw.family_score < thresholdFor(config.floors, family)) {
    routed = null;
    reason = 'below_family_floor';
  } else if (config.abstainVetoMargin != null && raw.abstain_score != null
      && raw.abstain_score - raw.family_score >= config.abstainVetoMargin) {
    routed = null;
    reason = 'abstain_veto';
  } else if (margin < thresholdFor(config.margins, family)
      && raw.topk_agreement < config.agreeFrac) {
    routed = null;
    reason = 'ambiguous_family_margin';
  }

  return {
    family: routed,
    score: round(raw.family_score, 4),
    candidate_family: family,
    family_score: round(raw.family_score, 4),
    runner_up: raw.runner_up,
    family_margin: round(margin, 4),
    abstain_score: raw.abstain_score == null ? null : round(raw.abstain_score, 4),
    abstain_delta: raw.abstain_score == null ? null : round(raw.abstain_score - raw.family_score, 4),
    topk_agreement: round(raw.topk_agreement, 3),
    route_gate: routed ? 'route' : 'abstain',
    abstain_reason: reason,
    top2: [family, raw.runner_up],
  };
}

function validatePolicy(raw, exemplarsPath, requireAbstain) {
  if (!raw || !raw.classes || typeof raw.classes !== 'object') {
    throw new Error(`invalid exemplars policy: ${exemplarsPath}`);
  }
  const allowed = new Set([...FAMILIES, 'abstain']);
  for (const key of Object.keys(raw.classes)) if (!allowed.has(key)) throw new Error(`unknown exemplar class: ${key}`);
  for (const family of FAMILIES) {
    if (!Array.isArray(raw.classes[family]) || raw.classes[family].length === 0) {
      throw new Error(`missing exemplars for family: ${family}`);
    }
  }
  if (requireAbstain && (!Array.isArray(raw.classes.abstain) || raw.classes.abstain.length === 0)) {
    throw new Error('abstain veto requires abstain exemplars');
  }
}

function validateCache(payload, key, items) {
  if (!payload || payload.schema_version !== 1 || payload.cache_key !== key || !Array.isArray(payload.vectors)) {
    throw new Error('invalid semantic cache metadata');
  }
  if (payload.vectors.length !== items.length) throw new Error('semantic cache vector count mismatch');
  let dimension = null;
  payload.vectors.forEach((entry, index) => {
    if (!entry || entry.cls !== items[index].cls || entry.text !== items[index].text) {
      throw new Error('semantic cache exemplar mismatch');
    }
    dimension = assertVector(entry.v, `cache vector ${index}`, dimension);
  });
  return payload.vectors;
}

async function createSemanticClassifier({
  exemplarsPath,
  floors = 0.55,
  margins = 0.02,
  topk = 5,
  agreeFrac = 0.6,
  abstainVetoMargin = null,
  cacheDir,
  embedFn = embed,
  embedModelIdentity = null,
} = {}) {
  const gateConfig = validateGateConfig({ floors, margins, topk, agreeFrac, abstainVetoMargin });
  if (!exemplarsPath) throw new TypeError('exemplarsPath is required');
  if (cacheDir && !embedModelIdentity) throw new TypeError('embedModelIdentity is required when cacheDir is used');
  const policyBytes = fs.readFileSync(exemplarsPath, 'utf8');
  const raw = YAML.parse(policyBytes);
  validatePolicy(raw, exemplarsPath, abstainVetoMargin != null);
  const version = raw.policy_version || 'exemplars-v0';

  const items = [];
  for (const cls of [...FAMILIES, 'abstain']) {
    for (const phrase of raw.classes[cls] || []) {
      const text = normalizeText(String(phrase));
      if (!text) throw new Error(`empty exemplar in class: ${cls}`);
      items.push({ cls, text });
    }
  }
  const fingerprintInput = {
    policy_sha256: crypto.createHash('sha256').update(policyBytes).digest('hex'),
    version,
    normalization: NORMALIZATION_VERSION,
    embed_model_identity: embedModelIdentity,
    items,
  };
  const key = crypto.createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
  const cacheFile = cacheDir ? path.join(cacheDir, `exemplars-${key.slice(0, 16)}.json`) : null;
  let vectors;
  if (cacheFile && fs.existsSync(cacheFile)) {
    vectors = validateCache(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), key, items);
  } else {
    const embeddings = await embedFn(items.map((item) => item.text));
    if (!Array.isArray(embeddings) || embeddings.length !== items.length) throw new Error('exemplar embedding count mismatch');
    let dimension = null;
    vectors = items.map((item, index) => {
      dimension = assertVector(embeddings[index], `exemplar embedding ${index}`, dimension);
      return { ...item, v: l2norm(embeddings[index]), index };
    });
    if (cacheFile) {
      fs.mkdirSync(cacheDir, { recursive: true });
      const payload = { schema_version: 1, cache_key: key, dimension, vectors };
      const temporary = `${cacheFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload));
      fs.renameSync(temporary, cacheFile);
    }
  }
  vectors = vectors.map((entry, index) => ({ ...entry, index }));
  const dimension = assertVector(vectors[0].v, 'first exemplar vector');
  for (let index = 1; index < vectors.length; index += 1) assertVector(vectors[index].v, `exemplar vector ${index}`, dimension);

  async function score(text) {
    const normalized = normalizeText(text);
    if (!normalized) throw new TypeError('semantic text must not be empty');
    const embeddings = await embedFn([normalized]);
    if (!Array.isArray(embeddings) || embeddings.length !== 1) throw new Error('query embedding count mismatch');
    assertVector(embeddings[0], 'query embedding', dimension);
    const query = l2norm(embeddings[0]);
    const familyBest = Object.fromEntries(FAMILIES.map((family) => [family, -Infinity]));
    const familySimilarities = [];
    let abstainBest = null;
    for (const exemplar of vectors) {
      const similarity = dot(query, exemplar.v);
      if (exemplar.cls === 'abstain') {
        if (abstainBest == null || similarity > abstainBest) abstainBest = similarity;
      } else {
        if (similarity > familyBest[exemplar.cls]) familyBest[exemplar.cls] = similarity;
        familySimilarities.push({ cls: exemplar.cls, similarity, index: exemplar.index });
      }
    }
    const ranked = FAMILIES.map((family, index) => ({ family, score: familyBest[family], index }))
      .sort((a, b) => (b.score - a.score) || (a.index - b.index));
    const neighbors = familySimilarities
      .sort((a, b) => (b.similarity - a.similarity) || (a.index - b.index))
      .slice(0, Math.min(topk, familySimilarities.length));
    const agreement = neighbors.filter((neighbor) => neighbor.cls === ranked[0].family).length / neighbors.length;
    return {
      candidate_family: ranked[0].family,
      family_score: ranked[0].score,
      runner_up: ranked[1].family,
      runner_up_score: ranked[1].score,
      abstain_score: abstainBest,
      topk_agreement: agreement,
    };
  }

  async function classify(text) {
    return applySemanticGate(await score(text), gateConfig);
  }

  const configFingerprint = crypto.createHash('sha256').update(JSON.stringify({ key, gateConfig })).digest('hex');
  return {
    classify,
    score,
    version,
    fingerprint: `semantic-${configFingerprint.slice(0, 16)}`,
    exemplarFingerprint: key,
    embedModelIdentity,
    normalizationVersion: NORMALIZATION_VERSION,
    similarity: 'cosine-l2-v1',
    families: FAMILIES,
    gateConfig: Object.freeze({ ...gateConfig }),
  };
}

async function createSemanticClassifierFromLock({
  lockPath,
  exemplarsPath,
  cacheDir,
  embedFn = embed,
  embedModelIdentity,
} = {}) {
  if (!lockPath || !exemplarsPath) throw new TypeError('lockPath and exemplarsPath are required');
  if (!embedModelIdentity) throw new TypeError('embedModelIdentity is required');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.schema_version !== 1 || lock.status !== 'locked') throw new Error('semantic gate lock is not locked schema version 1');
  if (lock.embed_model_identity !== embedModelIdentity) throw new Error('semantic gate lock embedding model identity mismatch');
  if (lock.normalization !== NORMALIZATION_VERSION || lock.similarity !== 'cosine-l2-v1') {
    throw new Error('semantic gate lock preprocessing is unsupported');
  }
  if (lock.context_policy !== 'current-turn-only-v1') throw new Error('semantic gate lock context policy is unsupported');
  const exemplarHash = crypto.createHash('sha256').update(fs.readFileSync(exemplarsPath)).digest('hex');
  if (lock.exemplar_sha256 !== exemplarHash) throw new Error('semantic gate lock exemplar hash mismatch');
  const classifier = await createSemanticClassifier({
    exemplarsPath,
    floors: lock.family_floors,
    margins: lock.family_margins,
    topk: lock.topk,
    agreeFrac: lock.agreement_fraction,
    abstainVetoMargin: lock.abstain_veto_margin,
    cacheDir,
    embedFn,
    embedModelIdentity,
  });
  if (classifier.fingerprint !== lock.classifier_fingerprint) throw new Error('semantic gate lock classifier fingerprint mismatch');
  return classifier;
}

module.exports = {
  FAMILIES,
  NORMALIZATION_VERSION,
  applySemanticGate,
  assertVector,
  createSemanticClassifier,
  createSemanticClassifierFromLock,
  dot,
  l2norm,
  normalizeText,
  validateGateConfig,
};
