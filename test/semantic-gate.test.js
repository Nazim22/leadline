'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  applySemanticGate,
  createSemanticClassifier,
  createSemanticClassifierFromLock,
  normalizeText,
} = require('../src/semantic');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-semantic-'));
  const exemplarsPath = path.join(root, 'exemplars.yaml');
  fs.writeFileSync(exemplarsPath, [
    'policy_version: test-v1',
    'classes:',
    '  historical: [history]',
    '  structural: [structure]',
    '  repository: [repository]',
    '  runtime: [runtime]',
    '  abstain: [action]',
    '',
  ].join('\n'));
  const vectors = {
    history: [0.8, 0.6, 0], structure: [0, 1, 0], repository: [0, 0, 1],
    runtime: [0.7, 0.7, 0], action: [0.99, 0.1, 0], query: [1, 0, 0],
  };
  const embedFn = async (texts) => texts.map((text) => vectors[text]);
  return { root, exemplarsPath, embedFn };
}

test('normalization is frozen and deterministic', () => {
  assert.equal(normalizeText('  did\u00a0we   ship?  '), 'did we ship?');
  assert.equal(normalizeText('ＡＢＣ'), 'ABC');
});

test('family argmax excludes abstain unless the veto is enabled', async () => {
  const { exemplarsPath, embedFn } = fixture();
  const classifier = await createSemanticClassifier({
    exemplarsPath, embedFn, embedModelIdentity: 'test@sha256:1', floors: -1,
    margins: 0, topk: 1, agreeFrac: 1, abstainVetoMargin: null,
  });
  const verdict = await classifier.classify('query');
  assert.equal(verdict.candidate_family, 'historical');
  assert.equal(verdict.family, 'historical');
  assert.ok(verdict.abstain_score > verdict.family_score);
});

test('gate decisions use unrounded scores at threshold boundaries', () => {
  const verdict = applySemanticGate({
    candidate_family: 'historical', family_score: 0.60004,
    runner_up: 'runtime', runner_up_score: 0.58,
    abstain_score: 0.1, topk_agreement: 0,
  }, {
    floors: { historical: 0.6, structural: 0.6, repository: 0.6, runtime: 0.6 },
    margins: { historical: 0.02, structural: 0.02, repository: 0.02, runtime: 0.02 },
    topk: 1, agreeFrac: 1, abstainVetoMargin: null,
  });
  assert.equal(verdict.family_margin, 0.02);
  assert.equal(verdict.family, 'historical');
});

test('per-family threshold maps must be complete and finite', async () => {
  const { exemplarsPath, embedFn } = fixture();
  await assert.rejects(createSemanticClassifier({
    exemplarsPath, embedFn, embedModelIdentity: 'test@sha256:1',
    floors: { historical: 0.5 }, margins: 0,
  }), /floors must define exactly/);
});

test('cache is bound to the embedding model identity', async () => {
  const { root, exemplarsPath, embedFn } = fixture();
  let calls = 0;
  const counted = async (texts) => { calls += 1; return embedFn(texts); };
  const base = { exemplarsPath, embedFn: counted, cacheDir: path.join(root, 'cache'), floors: -1, margins: 0 };
  await createSemanticClassifier({ ...base, embedModelIdentity: 'model@digest-a' });
  await createSemanticClassifier({ ...base, embedModelIdentity: 'model@digest-a' });
  await createSemanticClassifier({ ...base, embedModelIdentity: 'model@digest-b' });
  assert.equal(calls, 2);
});

test('cache use requires a verified model identity', async () => {
  const { root, exemplarsPath, embedFn } = fixture();
  await assert.rejects(createSemanticClassifier({
    exemplarsPath, embedFn, cacheDir: path.join(root, 'cache'), floors: -1, margins: 0,
  }), /embedModelIdentity/);
});

test('locked classifier fails closed on model or exemplar drift', async () => {
  const { root, exemplarsPath, embedFn } = fixture();
  const config = {
    floors: { historical: 0.5, structural: 0.5, repository: 0.5, runtime: 0.5 },
    margins: { historical: 0.02, structural: 0.02, repository: 0.02, runtime: 0.02 },
    topk: 1, agreeFrac: 1, abstainVetoMargin: null,
  };
  const identity = 'test@sha256:1';
  const classifier = await createSemanticClassifier({ exemplarsPath, embedFn, embedModelIdentity: identity, ...config });
  const lockPath = path.join(root, 'lock.json');
  fs.writeFileSync(lockPath, JSON.stringify({
    schema_version: 1,
    status: 'locked',
    embed_model_identity: identity,
    normalization: 'nfkc-ws-v1',
    similarity: 'cosine-l2-v1',
    context_policy: 'current-turn-only-v1',
    exemplar_sha256: crypto.createHash('sha256').update(fs.readFileSync(exemplarsPath)).digest('hex'),
    classifier_fingerprint: classifier.fingerprint,
    family_floors: config.floors,
    family_margins: config.margins,
    topk: config.topk,
    agreement_fraction: config.agreeFrac,
    abstain_veto_margin: config.abstainVetoMargin,
  }));
  const loaded = await createSemanticClassifierFromLock({ lockPath, exemplarsPath, embedFn, embedModelIdentity: identity });
  assert.equal(loaded.fingerprint, classifier.fingerprint);
  await assert.rejects(createSemanticClassifierFromLock({
    lockPath, exemplarsPath, embedFn, embedModelIdentity: 'test@sha256:2',
  }), /model identity mismatch/);
  fs.appendFileSync(exemplarsPath, '\n# drift\n');
  await assert.rejects(createSemanticClassifierFromLock({
    lockPath, exemplarsPath, embedFn, embedModelIdentity: identity,
  }), /exemplar hash mismatch/);
});
