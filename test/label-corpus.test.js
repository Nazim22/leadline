'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {
  LABELER_MODELS,
  RUBRIC_SHA256,
  RUBRIC_VERSION,
  labelCorpus,
  openAnchoredDirectory,
  readRegularNoFollow,
  validateConfig,
  validateInputs,
  writeLabelOutputs,
} = require('../scripts/label-corpus');
const {
  openAnchoredDirectory: openScoreDirectory,
  readRegularNoFollow: readScoreRegularNoFollow,
} = require('../scripts/score-exam');

function corpusRows() {
  return [
    {
      schema_version: 1,
      completion_id: 'completion-111111111111111111111111',
      session_id: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
      turn_id: 'turn-1',
      completed_at: '2026-07-24T02:00:00.000Z',
      completion: 'The API is live.',
      strata: ['keyword_positive'],
      tool_calls: [],
    },
    {
      schema_version: 1,
      completion_id: 'completion-222222222222222222222222',
      session_id: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
      turn_id: 'turn-2',
      completed_at: '2026-07-24T02:01:00.000Z',
      completion: 'I will investigate next.',
      strata: ['keyword_negative'],
      tool_calls: [],
    },
  ];
}

function contextRows() {
  return [
    {
      schema_version: 1,
      completion_id: 'completion-111111111111111111111111',
      session_id: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
      target_turn_id: 'turn-1',
      preceding_turn_id: 'turn-0',
      messages: [{ role: 'user', content: 'Is the API deployed and healthy?' }],
    },
    {
      schema_version: 1,
      completion_id: 'completion-222222222222222222222222',
      session_id: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
      target_turn_id: 'turn-2',
      preceding_turn_id: 'turn-1',
      messages: [{ role: 'user', content: 'Please investigate the API.' }],
    },
  ];
}

function boundInputBytes() {
  const corpusText = `${corpusRows().map(JSON.stringify).join('\n')}\n`;
  const contextText = `${contextRows().map(JSON.stringify).join('\n')}\n`;
  return {
    corpusText,
    contextText,
    expectedContextSha256: crypto.createHash('sha256').update(contextText).digest('hex'),
  };
}

function config() {
  return {
    schema_version: 1,
    base_url: 'https://openrouter.ai/api/v1',
    labelers: [
      { id: 'lane-a', model_identity: 'deepseek/deepseek-v4-pro' },
      { id: 'lane-b', model_identity: 'x-ai/grok-4.5' },
    ],
  };
}

function validContent(completionId) {
  if (completionId.endsWith('1'.repeat(24))) {
    return JSON.stringify({
      schema_version: 1,
      claims: [{
        span_exact_text: 'The API is live.',
        family: 'runtime',
        entity: 'API',
        confidence: 0.98,
        relevant_evidence_contact_visible: 'no',
      }],
    });
  }
  return JSON.stringify({ schema_version: 1, claims: [] });
}

function response(model, content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { model, choices: [{ message: { content } }] };
    },
  };
}

function deterministicFetch({ invalidateFirst = false, alwaysInvalid = false } = {}) {
  const calls = [];
  const attempts = new Map();
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    const payload = JSON.parse(body.messages[1].content);
    const key = `${body.model}:${payload.completion_id}`;
    attempts.set(key, (attempts.get(key) || 0) + 1);
    calls.push({ url, options, body, payload });
    const invalid = alwaysInvalid || (invalidateFirst && key.startsWith('deepseek/') && attempts.get(key) === 1);
    return response(body.model, invalid
      ? '{"schema_version":1,"claims":[],"extra":true}'
      : validContent(payload.completion_id));
  };
  return { calls, fetchFn };
}

test('endpoint and context provenance reject bypasses before labeling', () => {
  assert.throws(() => validateConfig({ ...config(), base_url: 'https://openrouter.ai:444/api/v1' }), /openrouter/u);
  assert.throws(() => validateConfig({
    ...config(),
    labelers: [
      { id: 'lane-a', model_identity: 'x-ai/grok-4.5' },
      { id: 'lane-b', model_identity: 'deepseek/deepseek-v4-pro' },
    ],
  }), /lane-a|locked|mapping/u);
  const copied = contextRows();
  copied[0] = {
    ...copied[0],
    messages: [{ role: 'assistant', content: corpusRows()[0].completion }],
  };
  assert.throws(() => validateInputs(corpusRows(), copied), /repeat|completion/u);
  const foreign = contextRows();
  foreign[0] = { ...foreign[0], session_id: 'session-bbbbbbbbbbbbbbbbbbbbbbbb' };
  assert.throws(() => validateInputs(corpusRows(), foreign), /session/u);
});

test('dual labelers receive only blind context and completion data in deterministic corpus order', async () => {
  const firstTransport = deterministicFetch();
  const first = await labelCorpus({
    corpusRows: corpusRows(),
    contextRows: contextRows(),
    config: config(),
    apiKey: 'secre...ey',
    fetchFn: firstTransport.fetchFn,
    inputBytes: boundInputBytes(),
  });
  const second = await labelCorpus({
    corpusRows: corpusRows(),
    contextRows: contextRows(),
    config: config(),
    apiKey: 'secre...ey',
    fetchFn: deterministicFetch().fetchFn,
    inputBytes: boundInputBytes(),
  });

  assert.deepEqual(first, second);
  assert.deepEqual(LABELER_MODELS, ['deepseek/deepseek-v4-pro', 'x-ai/grok-4.5']);
  assert.equal(RUBRIC_VERSION, 'detector-gold-v0.1');
  assert.equal(first.lanes.length, 2);
  assert.deepEqual(first.lanes.map((lane) => lane.rows.length), [2, 2]);
  assert.equal(first.lanes[0].rows[0].rubric_sha256, RUBRIC_SHA256);
  assert.equal(first.lanes[0].rows[0].claims[0].span_exact_text, 'The API is live.');
  assert.equal(first.lanes[0].rows[1].claims.length, 0);

  for (const call of firstTransport.calls) {
    assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.authorization, 'Bearer secre...ey');
    assert.equal(call.body.temperature, 0);
    assert.equal(call.body.seed, 0);
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.deepEqual(Object.keys(call.payload).sort(), ['completion', 'completion_id', 'preceding_context']);
    assert.equal(JSON.stringify(call.payload).includes('prediction'), false);
    assert.equal(JSON.stringify(call.payload).includes('candidate'), false);
    assert.equal(JSON.stringify(call.payload).includes('artifact'), false);
  }
  assert.equal(JSON.stringify(first).includes('secret-labeler-key'), false);
});

test('labeling summary binds the exact operator-locked corpus and context bytes', async () => {
  const corpusText = `${corpusRows().map((row) => ` ${JSON.stringify(row)} `).join('\n')}\n`;
  const contextText = `${contextRows().map((row) => ` ${JSON.stringify(row)} `).join('\n')}\n`;
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const result = await labelCorpus({
    corpusRows: corpusRows(), contextRows: contextRows(), config: config(),
    apiKey: 'secre...ey', fetchFn: deterministicFetch().fetchFn,
    inputBytes: { corpusText, contextText, expectedContextSha256: sha(contextText) },
  });
  assert.equal(result.corpus_sha256, sha(corpusText));
  assert.equal(result.context_sha256, sha(contextText));
  await assert.rejects(() => labelCorpus({
    corpusRows: corpusRows(), contextRows: contextRows(), config: config(),
    apiKey: 'secre...ey', fetchFn: deterministicFetch().fetchFn,
    inputBytes: { corpusText, contextText, expectedContextSha256: '0'.repeat(64) },
  }), /operator-locked|context.*SHA/u);
});

test('invalid strict JSON is retried once and every invalid attempt is counted without dropping the row', async () => {
  const transport = deterministicFetch({ invalidateFirst: true });
  const result = await labelCorpus({
    corpusRows: corpusRows(), contextRows: contextRows(), config: config(),
    apiKey: 'secre...ey', fetchFn: transport.fetchFn, inputBytes: boundInputBytes(),
  });
  const laneA = result.lanes.find((lane) => lane.labeler_id === 'lane-a');
  assert.equal(laneA.invalid_attempt_count, 2);
  assert.equal(laneA.operational_failure_attempt_count, 2);
  assert.equal(laneA.operational_failure_rows, 0);
  assert.deepEqual(laneA.rows.map((row) => row.attempts), [2, 2]);
  assert.deepEqual(laneA.rows.map((row) => row.invalid_attempts), [1, 1]);
  assert.deepEqual(laneA.rows.map((row) => row.operational_failure_attempts), [1, 1]);
  assert.equal(laneA.rows.every((row) => row.status === 'ok'), true);

  const failed = await labelCorpus({
    corpusRows: corpusRows(), contextRows: contextRows(), config: config(),
    apiKey: 'secre...ey', fetchFn: deterministicFetch({ alwaysInvalid: true }).fetchFn,
    inputBytes: boundInputBytes(),
  });
  for (const lane of failed.lanes) {
    assert.equal(lane.rows.length, 2);
    assert.equal(lane.operational_failure_rows, 2);
    assert.equal(lane.rows.every((row) => row.status === 'operational_failure'), true);
    assert.equal(lane.rows.every((row) => row.failure === 'invalid_response'), true);
    assert.equal(lane.rows.every((row) => row.operational_failure_attempts === 2), true);
    assert.equal(lane.rows.every((row) => row.claims === null), true);
  }
});

test('input reads reject final-component and ancestor symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-nofollow-'));
  const realDir = path.join(root, 'real');
  fs.mkdirSync(realDir);
  const source = path.join(realDir, 'input.jsonl');
  fs.writeFileSync(source, '{}\n');
  const finalLink = path.join(realDir, 'final-link.jsonl');
  fs.symlinkSync(source, finalLink);
  assert.throws(() => readRegularNoFollow(finalLink, 'input'), /symlink|ELOOP/u);
  const ancestorLink = path.join(root, 'ancestor-link');
  fs.symlinkSync(realDir, ancestorLink);
  assert.throws(() => readRegularNoFollow(path.join(ancestorLink, 'input.jsonl'), 'input'), /symlink/u);
});

test('ancestor replacement during acquisition cannot redirect a read', () => {
  for (const [implementation, readNoFollow] of [
    ['label', readRegularNoFollow],
    ['score', readScoreRegularNoFollow],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `leadline-${implementation}-swap-`));
    const safe = path.join(root, 'safe');
    const held = path.join(root, 'held');
    const evil = path.join(root, 'evil');
    fs.mkdirSync(path.join(safe, 'exam'), { recursive: true });
    fs.mkdirSync(path.join(evil, 'exam'), { recursive: true });
    fs.writeFileSync(path.join(safe, 'exam', 'input.jsonl'), 'trusted\n');
    fs.writeFileSync(path.join(evil, 'exam', 'input.jsonl'), 'redirected\n');
    const parent = path.join(safe, 'exam');
    const originalOpen = fs.openSync;
    let swapped = false;
    fs.openSync = function swapAncestor(file, ...args) {
      const candidate = String(file);
      if (!swapped && candidate === parent) {
        fs.renameSync(safe, held);
        fs.symlinkSync(evil, safe, 'dir');
        swapped = true;
      }
      const descriptor = originalOpen.call(fs, file, ...args);
      if (!swapped && candidate.startsWith('/proc/self/fd/') && candidate.endsWith('/safe')) {
        fs.renameSync(safe, held);
        fs.symlinkSync(evil, safe, 'dir');
        swapped = true;
      }
      return descriptor;
    };
    try {
      assert.equal(readNoFollow(path.join(safe, 'exam', 'input.jsonl'), 'input').toString('utf8'), 'trusted\n');
      assert.equal(swapped, true);
    } finally {
      fs.openSync = originalOpen;
    }
  }
});

test('repository directory acquisition rejects final and ancestor symlinks', () => {
  for (const [implementation, openDirectory] of [
    ['label', openAnchoredDirectory],
    ['score', openScoreDirectory],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `leadline-${implementation}-repo-nofollow-`));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const finalLink = path.join(root, 'repo-link');
    fs.symlinkSync(repo, finalLink, 'dir');
    assert.throws(() => openDirectory(finalLink, 'repository'), /symlink|ELOOP/u);
    const ancestorLink = path.join(root, 'ancestor-link');
    fs.symlinkSync(root, ancestorLink, 'dir');
    assert.throws(() => openDirectory(path.join(ancestorLink, 'repo'), 'repository'), /symlink|ELOOP/u);
  }
});

test('label outputs and hashes are deterministic private files', async () => {
  const result = await labelCorpus({
    corpusRows: corpusRows(), contextRows: contextRows(), config: config(),
    apiKey: 'secre...ey', fetchFn: deterministicFetch().fetchFn,
    inputBytes: boundInputBytes(),
  });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-labels-'));
  fs.chmodSync(outputDir, 0o700);
  const summary = writeLabelOutputs(outputDir, result);

  assert.deepEqual(Object.keys(summary.lanes).sort(), ['lane-a', 'lane-b']);
  for (const lane of result.lanes) {
    const labelPath = path.join(outputDir, `${lane.labeler_id}.labels.jsonl`);
    const hashPath = `${labelPath}.sha256`;
    assert.equal(fs.statSync(labelPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(hashPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(hashPath, 'utf8'), `${summary.lanes[lane.labeler_id].sha256}\n`);
    assert.equal(fs.readFileSync(labelPath, 'utf8').includes('secret-labeler-key'), false);
  }
  assert.equal(fs.statSync(path.join(outputDir, 'labeling-summary.json')).mode & 0o777, 0o600);
});
