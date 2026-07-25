'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { loadAuthorityPolicy } = require('../src/authority');
const {
  extractCorpusRows, parseQuotas, parseTranscript, serializeJsonl, sha256Text, verifyExtractionRuntime,
} = require('../scripts/extract-corpus');
const {
  assertFrozenInputFile, buildProvenanceManifest, createFrozenDetector, createLocalFetch,
  main: replayMain, replayRows, validateManifestForCorpus, writePrivate,
} = require('../scripts/replay');

const ROOT = path.join(__dirname, '..');
const FROZEN_COMMIT = '8488cb333157208e9781f8d3c32ea0dda587a368';

function compileSchema(name) {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', name), 'utf8'));
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', true);
  return ajv.compile(schema);
}

function writeTranscript(directory) {
  const events = [
    { type: 'user', sessionId: 'private-session', uuid: 'u1', timestamp: '2026-07-24T01:00:00.000Z', message: { content: 'Check it.' } },
    { type: 'assistant', sessionId: 'private-session', uuid: 'a1', timestamp: '2026-07-24T01:00:01.000Z', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', sessionId: 'private-session', uuid: 'r1', timestamp: '2026-07-24T01:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '3 tests passed', is_error: false, executed_test_count: 3, exit_code: 0 }] } },
    { type: 'assistant', sessionId: 'private-session', uuid: 'a2', timestamp: '2026-07-24T01:00:03.000Z', message: { content: 'The tests passed. bearer AAAAAAAAAAAAAAAAAAAAAAAA' } },
    { type: 'user', sessionId: 'private-session', uuid: 'u2', timestamp: '2026-07-24T01:01:00.000Z', message: { content: 'Next.' } },
    { type: 'assistant', sessionId: 'private-session', uuid: 'a3', timestamp: '2026-07-24T01:01:01.000Z', message: { content: 'I will investigate this next.' } },
    { type: 'assistant', sessionId: 'private-session', uuid: 'a3-final', timestamp: '2026-07-24T01:01:02.000Z', message: { content: 'I will investigate this finally.' } },
    { type: 'user', sessionId: 'private-session', uuid: 'u3', timestamp: '2026-07-24T01:02:00.000Z', message: { content: 'Explain.' } },
    { type: 'assistant', sessionId: 'private-session', uuid: 'a4', timestamp: '2026-07-24T01:02:01.000Z', message: { content: 'Example only: `the API is live`.' } },
    { type: 'user', sessionId: 'private-session', uuid: 'u4', timestamp: '2026-07-24T01:03:00.000Z', message: { content: 'Status.' } },
    { type: 'assistant', sessionId: 'private-session', uuid: 'a5', timestamp: '2026-07-24T01:03:01.000Z', message: { content: 'The subagent is running in the background.' } },
  ];
  fs.writeFileSync(path.join(directory, 'session.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);
}

function syntheticCorpus() {
  const base = {
    schema_version: 1,
    session_id: 'session-aaaaaaaaaaaaaaaaaaaaaaaa',
    strata: ['keyword_positive'],
    tool_calls: [],
  };
  return [
    {
      ...base,
      completion_id: 'completion-111111111111111111111111', turn_id: 'turn-1', completed_at: '2026-07-24T02:00:00.000Z',
      completion: 'The tests passed.',
      tool_calls: [{
        tool_call_id: 'tool-bbbbbbbbbbbbbbbbbbbbbbbb', provider: 'bash', name: 'bash', args: { command: 'npm test' },
        result: {
          value: '3 tests passed', error: null, exit_code: 0, is_error: false, http_status: null,
          executed_test_count: 3, observed_at: '2026-07-24T01:59:59.000Z', truncated: false,
        },
      }],
    },
    {
      ...base,
      completion_id: 'completion-222222222222222222222222', turn_id: 'turn-2', completed_at: '2026-07-24T02:01:00.000Z',
      completion: 'The API is live.',
    },
    {
      ...base,
      completion_id: 'completion-333333333333333333333333', turn_id: 'turn-3', completed_at: '2026-07-24T02:02:00.000Z',
      completion: 'I will investigate next.', strata: ['keyword_negative'],
    },
  ];
}

function fakeDetector() {
  return {
    detector_fingerprint: 'claim-detector-fixture',
    model_identity: 'ollama:fixture@digest',
    async detect(text) {
      if (text.includes('API')) {
        return {
          status: 'unavailable', failure: 'llm_request_failed', candidate_count: 1,
          detector_fingerprint: this.detector_fingerprint, model_identity: this.model_identity,
          obligations: [], rejected: [],
        };
      }
      if (text.includes('investigate')) {
        return {
          status: 'ok', candidate_count: 0, detector_fingerprint: this.detector_fingerprint,
          model_identity: this.model_identity, obligations: [], rejected: [],
        };
      }
      return {
        status: 'ok', candidate_count: 1, detector_fingerprint: this.detector_fingerprint,
        model_identity: this.model_identity, rejected: [],
        obligations: [{
          claim_id: 'claim-tests', candidate_id: 'test-pass:0', pattern_id: 'test-pass',
          claim: 'The tests passed.', family: 'runtime', entity: 'tests', confidence: 1,
          evidence: { authority_tier: 1, freshness: { requirement: 'fresh', max_age_seconds: 600 } },
        }],
      };
    },
  };
}

test('extraction runtime verifies its explicit causal closure', () => {
  assert.doesNotThrow(() => verifyExtractionRuntime(ROOT));
});

test('corpus extraction is seeded, stratified, sanitized before persistence, and schema-valid', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-extract-'));
  writeTranscript(directory);
  const quotas = parseQuotas('keyword_positive=1,keyword_negative=1,quotes_code=1,subagent_process=1');
  const one = extractCorpusRows({ transcriptsDir: directory, seed: 'fixture-seed', quotas });
  const two = extractCorpusRows({ transcriptsDir: directory, seed: 'fixture-seed', quotas });
  assert.deepEqual(one, two);
  assert.ok(one.some((row) => row.strata.includes('keyword_positive')));
  assert.ok(one.some((row) => row.strata.includes('keyword_negative')));
  assert.ok(one.some((row) => row.strata.includes('quotes_code')));
  assert.ok(one.some((row) => row.strata.includes('subagent_process')));
  const persisted = serializeJsonl(one);
  assert.equal(persisted.includes('private-session'), false);
  assert.equal(persisted.includes('AAAAAAAAAAAAAAAAAAAAAAAA'), false);
  assert.equal(persisted.includes('I will investigate this next.'), false);
  assert.match(sha256Text(persisted), /^[a-f0-9]{64}$/u);

  const validate = compileSchema('replay-corpus.schema.json');
  for (const row of one) assert.equal(validate(row), true, JSON.stringify(validate.errors));
});

test('an intermediate text-only assistant event is discarded when the turn later invokes a tool', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-stale-completion-'));
  const transcript = path.join(tmp, 'session.jsonl');
  const events = [
    { type: 'user', timestamp: '2026-07-24T00:00:00.000Z', message: { content: 'Run it.' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-07-24T00:00:01.000Z', message: { content: 'The tests passed.' } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-07-24T00:00:02.000Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
  ];
  fs.writeFileSync(transcript, `${events.map(JSON.stringify).join('\n')}\n`);
  assert.deepEqual(parseTranscript(transcript, tmp, 'fixed-seed'), []);
});

test('three-completion replay is deterministic, coverage-only, and retains every denominator row', async () => {
  const corpus = syntheticCorpus();
  const validateCorpus = compileSchema('replay-corpus.schema.json');
  for (const row of corpus) assert.equal(validateCorpus(row), true, JSON.stringify(validateCorpus.errors));
  const corpusText = serializeJsonl(corpus);
  const manifest = buildProvenanceManifest({
    corpusText, corpusRows: corpus, labelSetIdentity: 'unlabeled', labelsText: null, repoPath: ROOT,
  });
  assert.equal(manifest.frozen.commit, FROZEN_COMMIT);
  assert.deepEqual(manifest.overrides, {});
  const policy = loadAuthorityPolicy(path.join(ROOT, 'policy', 'authority.yaml'));
  const first = await replayRows({ corpusRows: corpus, manifest, detector: fakeDetector(), policy });
  const second = await replayRows({ corpusRows: corpus, manifest, detector: fakeDetector(), policy });
  assert.deepEqual(first, second);
  assert.equal(first.artifact_rows.length, 3);
  assert.equal(first.summary.sampled_completions, 3);
  assert.deepEqual(first.summary.detector_status_counts, { invalid_response: 0, ok: 2, unavailable: 1 });
  assert.equal(first.summary.zero_candidate_completions, 1);
  assert.equal(first.summary.mode, 'coverage');
  assert.equal('precision' in first.summary, false);
  assert.equal('recall' in first.summary, false);
  assert.match(first.artifact_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.artifact_rows[1].detector.status, 'unavailable');
  assert.equal(first.artifact_rows[2].detector.candidate_count, 0);
  assert.equal(first.artifact_rows.every((row) => row.label_record === null), true);

  const validate = compileSchema('replay-artifact.schema.json');
  for (const row of first.artifact_rows) assert.equal(validate(row), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...first.artifact_rows[0], label_record: [] }), false);
});

test('invalid detector responses remain explicit operational-failure denominator rows', async () => {
  const corpus = [syntheticCorpus()[1]];
  const corpusText = serializeJsonl(corpus);
  const manifest = buildProvenanceManifest({
    corpusText, corpusRows: corpus, labelSetIdentity: 'unlabeled', labelsText: null, repoPath: ROOT,
  });
  const detector = {
    async detect() {
      return {
        status: 'invalid_response', failure: 'llm_schema_invalid', candidate_count: 1,
        detector_fingerprint: 'detector-fixture', model_identity: 'fixture-model', obligations: [], rejected: [],
      };
    },
  };
  const replay = await replayRows({
    corpusRows: corpus,
    manifest,
    detector,
    policy: loadAuthorityPolicy(path.join(ROOT, 'policy', 'authority.yaml')),
  });
  assert.equal(replay.artifact_rows.length, 1);
  assert.equal(replay.artifact_rows[0].coverage.detector_status, 'invalid_response');
  assert.equal(replay.summary.operational_failure_completions, 1);
  assert.equal(replay.summary.detector_status_counts.invalid_response, 1);
});

test('opaque blind labels are retained per completion without enabling aggregate scoring', async () => {
  const corpus = syntheticCorpus();
  const corpusText = serializeJsonl(corpus);
  const labelsText = serializeJsonl(corpus.map((row, index) => ({
    completion_id: row.completion_id,
    gold: index === 2 ? [{ claim: 'A deliberately missed claim.' }] : [],
  })));
  const manifest = buildProvenanceManifest({
    corpusText, corpusRows: corpus, labelSetIdentity: 'synthetic-blind-v1', labelsText, repoPath: ROOT,
  });
  const replay = await replayRows({
    corpusRows: corpus,
    manifest,
    detector: fakeDetector(),
    policy: loadAuthorityPolicy(path.join(ROOT, 'policy', 'authority.yaml')),
    labelsText,
  });
  assert.deepEqual(
    replay.artifact_rows[2].label_record.gold,
    [{ claim: 'A deliberately missed claim.' }],
  );
  assert.equal(replay.summary.labels_attached, true);
  assert.equal('precision' in replay.summary, false);
  assert.equal('recall' in replay.summary, false);
});

test('manifest validation rejects corpus hash mismatch and emits no scoring contract', () => {
  const corpus = syntheticCorpus();
  const corpusText = serializeJsonl(corpus);
  const manifest = buildProvenanceManifest({
    corpusText, corpusRows: corpus, labelSetIdentity: 'unlabeled', labelsText: null, repoPath: ROOT,
  });
  assert.throws(
    () => validateManifestForCorpus(manifest, `${corpusText}{"tampered":true}\n`, null, ROOT),
    /corpus sha256 mismatch/,
  );
  assert.equal(manifest.mode, 'coverage');
  assert.equal(JSON.stringify(manifest).includes('precision'), false);
  assert.equal(JSON.stringify(manifest).includes('recall'), false);

  const validate = compileSchema('replay-manifest.schema.json');
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

  const changedPolicy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-policy-')), 'authority.yaml');
  fs.writeFileSync(changedPolicy, 'changed\n');
  assert.throws(
    () => assertFrozenInputFile(ROOT, changedPolicy, 'policy/authority.yaml'),
    /does not match the frozen object/,
  );

  const duplicateLabels = serializeJsonl([
    { completion_id: corpus[0].completion_id, gold: [] },
    { completion_id: corpus[0].completion_id, gold: [] },
  ]);
  assert.throws(
    () => buildProvenanceManifest({
      corpusText, corpusRows: corpus, labelSetIdentity: 'duplicate-labels',
      labelsText: duplicateLabels, repoPath: ROOT,
    }),
    /duplicate label completion_id/,
  );

  const duplicateCorpus = [corpus[0], { ...corpus[0] }];
  assert.throws(
    () => buildProvenanceManifest({
      corpusText: serializeJsonl(duplicateCorpus), corpusRows: duplicateCorpus,
      labelSetIdentity: 'unlabeled', labelsText: null, repoPath: ROOT,
    }),
    /duplicate corpus completion_id/,
  );
});
test('localhost fetch disables redirects and private writes reject output symlinks', async () => {
  let observedOptions;
  const localFetch = createLocalFetch(async (_url, options) => {
    observedOptions = options;
    return { ok: true };
  });
  await localFetch('http://127.0.0.1:11434/api/tags', { method: 'GET', redirect: 'follow' });
  assert.equal(observedOptions.redirect, 'error');
  await assert.rejects(() => localFetch('https://example.com/api/tags', {}), /localhost/);
  await assert.rejects(() => localFetch('file:///tmp/socket', {}), /HTTP/);
  await assert.rejects(() => localFetch('http://user:pass@localhost:11434/api/tags', {}), /credentials/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-private-write-'));
  const configBuffer = fs.readFileSync(path.join(ROOT, 'policy', 'claim-detector.json'));
  const config = JSON.parse(configBuffer.toString('utf8'));
  const identity = /^ollama:(.+)@([^@]+)$/u.exec(config.model_identity);
  const configCopy = path.join(tmp, 'claim-detector.json');
  writePrivate(configCopy, configBuffer);
  const originalFetch = globalThis.fetch;
  let detectorFetchCalls = 0;
  globalThis.fetch = async (_url, options) => {
    detectorFetchCalls += 1;
    assert.equal(options.redirect, 'error');
    return {
      ok: true,
      status: 200,
      async json() { return { models: [{ name: identity[1], digest: identity[2] }] }; },
    };
  };
  try {
    const detector = await createFrozenDetector(configBuffer, configCopy, ROOT);
    assert.equal(detector.model_identity, config.model_identity);
    assert.equal(detectorFetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const target = path.join(tmp, 'target');
  const output = path.join(tmp, 'output');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, output);
  assert.throws(() => writePrivate(output, 'replace'), /symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');

  const corpusPath = path.join(tmp, 'corpus.jsonl');
  fs.writeFileSync(corpusPath, serializeJsonl(syntheticCorpus()));
  await assert.rejects(
    () => replayMain([
      'manifest', '--corpus', corpusPath, '--output', corpusPath,
      '--label-set-id', 'unlabeled', '--repo', ROOT,
    ]),
    /must not alias/,
  );
});
