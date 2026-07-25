#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Ajv2020 = require('ajv/dist/2020');
const {
  readRegularNoFollow, serializeJsonl, sha256Text, verifyFrozenRuntime, writePrivate,
} = require('./extract-corpus');

let runtimeCache = null;

const HARNESS_VERSION = 'replay-v0.1';
const FROZEN = Object.freeze({
  commit: '8488cb333157208e9781f8d3c32ea0dda587a368',
  tree: '1a3bd1de77558ecebf92ef4bed4a9d7bd1dfaca9',
  capability_map: Object.freeze({
    version: 'cap-v0.2',
    sha256: '7d6e892a79b2745c1f8158d9717f2a6a29acfc42841c25b262a3b74451fbf3c5',
    git_blob: 'ec73261eca1585edfa3ffaac43d40548a0cbe00d',
  }),
  contact_normalizer: Object.freeze({
    version: 'contact-normalizer-v0.3',
    sha256: '7d6e892a79b2745c1f8158d9717f2a6a29acfc42841c25b262a3b74451fbf3c5',
    git_blob: 'ec73261eca1585edfa3ffaac43d40548a0cbe00d',
  }),
  entity_matcher: Object.freeze({
    version: 'entmatch-v0.2',
    sha256: '2cbba3bf1a0366d641a2ba8b65fd564fa0c41428ed5f726cd9180251e1bf2366',
    git_blob: 'bd9f752986d5076d257e388426763bee78e26868',
  }),
  authority_policy: Object.freeze({
    version: 'authority-v0.3',
    sha256: '4316cc2d3023c1d4e3331f3e3e326c90af74d4de0b251c6a3032cf5889610fd7',
    git_blob: 'f5339a75219b067c9d49de840f7d1634e3a84007',
  }),
});

function readJsonlText(text, label) {
  const rows = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { throw new TypeError(`${label} line ${index + 1} is invalid JSON`); }
  }
  return rows;
}

function assertUniqueCorpusIds(rows) {
  const seen = new Set();
  for (const row of rows) {
    const id = row && row.completion_id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('each corpus row must have a non-empty completion_id');
    }
    if (seen.has(id)) throw new TypeError(`duplicate corpus completion_id: ${id}`);
    seen.add(id);
  }
}

const ROOT = path.join(__dirname, '..');

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
}

function frozenRuntime(repoPath = ROOT) {
  if (runtimeCache) return runtimeCache;
  verifyFrozenRuntime(repoPath);
  const capability = require('../src/capability');
  const entityMatch = require('../src/entity-match');
  runtimeCache = Object.freeze({
    canonicalize: require('../src/receipts').canonicalize,
    createChatClient: require('../src/llm').createChatClient,
    createConfiguredClaimDetector: require('../src/claim-detector').createConfiguredClaimDetector,
    createEvidenceContactReceipt: require('../src/evidence').createEvidenceContactReceipt,
    evaluateFinalization: require('../src/finalization').evaluateFinalization,
    loadAuthorityPolicy: require('../src/authority').loadAuthorityPolicy,
    CAPABILITY_MAP_VERSION: capability.CAPABILITY_MAP_VERSION,
    NORMALIZER_VERSION: capability.NORMALIZER_VERSION,
    capabilityMapSha: capability.capabilityMapSha,
    ENTITY_MATCHER_VERSION: entityMatch.ENTITY_MATCHER_VERSION,
    entityMatcherSha: entityMatch.entityMatcherSha,
  });
  return runtimeCache;
}

function readFrozenInputBuffer(repoPath, inputPath, frozenPath) {
  const actual = readRegularNoFollow(inputPath, frozenPath);
  const expected = execFileSync('git', ['-C', repoPath, 'show', `${FROZEN.commit}:${frozenPath}`]);
  if (!actual.equals(expected)) throw new Error(`${frozenPath} does not match the frozen object`);
  return actual;
}

function assertFrozenInputFile(repoPath, inputPath, frozenPath) {
  readFrozenInputBuffer(repoPath, inputPath, frozenPath);
}

function stagePrivateInputs(configBuffer, policyBuffer) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-replay-'));
  fs.chmodSync(directory, 0o700);
  const configPath = path.join(directory, 'claim-detector.json');
  const policyPath = path.join(directory, 'authority.yaml');
  writePrivate(configPath, configBuffer);
  writePrivate(policyPath, policyBuffer);
  return {
    configPath,
    policyPath,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function canonicalSha(value, repoPath = ROOT) {
  const { canonicalize } = frozenRuntime(repoPath);
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function validateFrozenCheckout(repoPath) {
  const scriptRepo = fs.realpathSync(ROOT);
  if (fs.realpathSync(repoPath) !== scriptRepo) {
    throw new Error('--repo must identify the repository executing this replay harness');
  }
  const commit = git(repoPath, ['rev-parse', FROZEN.commit]);
  const tree = git(repoPath, ['rev-parse', `${FROZEN.commit}^{tree}`]);
  if (commit !== FROZEN.commit || tree !== FROZEN.tree) throw new Error('frozen commit or tree mismatch');
  const blobs = {
    capability_map: git(repoPath, ['rev-parse', `${FROZEN.commit}:src/capability.js`]),
    contact_normalizer: git(repoPath, ['rev-parse', `${FROZEN.commit}:src/capability.js`]),
    entity_matcher: git(repoPath, ['rev-parse', `${FROZEN.commit}:src/entity-match.js`]),
    authority_policy: git(repoPath, ['rev-parse', `${FROZEN.commit}:policy/authority.yaml`]),
  };
  for (const [name, oid] of Object.entries(blobs)) {
    if (oid !== FROZEN[name].git_blob) throw new Error(`frozen ${name} git blob mismatch`);
  }
  const runtime = frozenRuntime(repoPath);
  if (runtime.CAPABILITY_MAP_VERSION !== FROZEN.capability_map.version
      || runtime.NORMALIZER_VERSION !== FROZEN.contact_normalizer.version
      || runtime.capabilityMapSha() !== FROZEN.capability_map.sha256
      || runtime.ENTITY_MATCHER_VERSION !== FROZEN.entity_matcher.version
      || runtime.entityMatcherSha() !== FROZEN.entity_matcher.sha256) {
    throw new Error('loaded frozen JavaScript component fingerprint mismatch');
  }
  const policyBuffer = execFileSync('git', ['-C', repoPath, 'show', `${FROZEN.commit}:policy/authority.yaml`]);
  const staged = stagePrivateInputs(Buffer.from('{}\n'), policyBuffer);
  let policy;
  try {
    policy = runtime.loadAuthorityPolicy(staged.policyPath);
  } finally {
    staged.cleanup();
  }
  if (policy.policy_version !== FROZEN.authority_policy.version
      || canonicalSha(policy, repoPath) !== FROZEN.authority_policy.sha256) {
    throw new Error('loaded frozen authority policy fingerprint mismatch');
  }
  return policy;
}

function schemaValidator(repoPath, name) {
  const schema = JSON.parse(fs.readFileSync(path.join(repoPath, 'schema', name), 'utf8'));
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      && Number.isFinite(Date.parse(value)),
  });
  return ajv.compile(schema);
}

function validateRows(rows, validator, label) {
  for (const [index, row] of rows.entries()) {
    if (!validator(row)) throw new TypeError(`${label} row ${index + 1} violates schema: ${JSON.stringify(validator.errors)}`);
  }
}

function buildProvenanceManifest({
  corpusText, corpusRows, labelSetIdentity, labelsText = null, repoPath,
} = {}) {
  if (typeof corpusText !== 'string' || corpusText.length === 0) throw new TypeError('corpusText must be non-empty');
  if (!Array.isArray(corpusRows) || corpusRows.length === 0) throw new TypeError('corpusRows must be non-empty');
  if (typeof labelSetIdentity !== 'string' || labelSetIdentity.length === 0) {
    throw new TypeError('labelSetIdentity must be non-empty');
  }
  if (typeof repoPath !== 'string' || repoPath.length === 0) throw new TypeError('repoPath must be non-empty');
  validateFrozenCheckout(repoPath);
  const { canonicalize } = frozenRuntime(repoPath);
  const parsedCorpusRows = readJsonlText(corpusText, 'corpus');
  if (canonicalize(parsedCorpusRows) !== canonicalize(corpusRows)) {
    throw new Error('corpusRows do not match corpusText');
  }
  assertUniqueCorpusIds(corpusRows);
  const labels = labelMap(labelsText, corpusRows);
  const manifest = {
    schema_version: 1,
    harness_version: HARNESS_VERSION,
    mode: 'coverage',
    frozen: FROZEN,
    corpus: { sha256: sha256Text(corpusText), row_count: corpusRows.length },
    labels: {
      identity: labelSetIdentity,
      sha256: labelsText == null ? null : sha256Text(labelsText),
      row_count: labelsText == null ? null : labels.size,
    },
    overrides: {},
  };
  const validate = schemaValidator(repoPath, 'replay-manifest.schema.json');
  if (!validate(manifest)) throw new TypeError(`generated manifest violates schema: ${JSON.stringify(validate.errors)}`);
  return manifest;
}

function validateManifestForCorpus(manifest, corpusText, labelsText, repoPath) {
  const validate = schemaValidator(repoPath, 'replay-manifest.schema.json');
  if (!validate(manifest)) throw new TypeError(`manifest violates schema: ${JSON.stringify(validate.errors)}`);
  validateFrozenCheckout(repoPath);
  const { canonicalize } = frozenRuntime(repoPath);
  if (canonicalize(manifest.frozen) !== canonicalize(FROZEN)) throw new Error('manifest frozen component mismatch');
  if (manifest.corpus.sha256 !== sha256Text(corpusText)) throw new Error('corpus sha256 mismatch');
  const corpusRows = readJsonlText(corpusText, 'corpus');
  assertUniqueCorpusIds(corpusRows);
  if (manifest.corpus.row_count !== corpusRows.length) throw new Error('corpus row count mismatch');
  if (labelsText == null) {
    if (manifest.labels.sha256 !== null || manifest.labels.row_count !== null) {
      throw new Error('manifest requires a labels file');
    }
  } else {
    if (manifest.labels.sha256 !== sha256Text(labelsText)) throw new Error('labels sha256 mismatch');
    const labels = labelMap(labelsText, corpusRows);
    if (manifest.labels.row_count !== labels.size) throw new Error('labels row count mismatch');
  }
  if (Object.keys(manifest.overrides).length !== 0 || manifest.mode !== 'coverage') {
    throw new Error('replay manifest must remain coverage-only with overrides:{}');
  }
  return corpusRows;
}

function labelMap(labelsText, corpusRows) {
  if (labelsText == null) return new Map();
  const rows = readJsonlText(labelsText, 'labels');
  const mapped = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.completion_id !== 'string' || row.completion_id.length === 0) {
      throw new TypeError('each label row must be an object with completion_id');
    }
    if (mapped.has(row.completion_id)) throw new TypeError(`duplicate label completion_id: ${row.completion_id}`);
    mapped.set(row.completion_id, row);
  }
  const corpusIds = new Set(corpusRows.map((row) => row.completion_id));
  if (mapped.size !== corpusIds.size || [...corpusIds].some((id) => !mapped.has(id))
      || [...mapped.keys()].some((id) => !corpusIds.has(id))) {
    throw new Error('labels must cover exactly every sampled completion');
  }
  return mapped;
}

function resultForReceipt(result) {
  const normalized = { value: result.value };
  for (const field of [
    'error', 'exit_code', 'is_error', 'http_status', 'executed_test_count', 'observed_at', 'truncated',
  ]) {
    if (result[field] !== null && result[field] !== false) normalized[field] = result[field];
    else if (field === 'is_error' && result[field] === false) normalized[field] = false;
    else if (field === 'truncated') normalized[field] = result[field];
  }
  return normalized;
}

async function replayRows({ corpusRows, manifest, detector, policy, labelsText = null } = {}) {
  const { createEvidenceContactReceipt, evaluateFinalization } = frozenRuntime();
  if (!Array.isArray(corpusRows) || corpusRows.length === 0) throw new TypeError('corpusRows must be non-empty');
  assertUniqueCorpusIds(corpusRows);
  if (!manifest || manifest.mode !== 'coverage' || Object.keys(manifest.overrides || {}).length !== 0) {
    throw new TypeError('manifest must be coverage-only with overrides:{}');
  }
  if (!detector || typeof detector.detect !== 'function') throw new TypeError('detector must expose detect');
  const labels = labelMap(labelsText, corpusRows);
  const artifactRows = [];
  const statusCounts = { invalid_response: 0, ok: 0, unavailable: 0 };
  let zeroCandidates = 0;
  let operationalFailures = 0;
  let evidenceContacts = 0;
  let obligations = 0;
  const stratumCounts = Object.fromEntries([
    'keyword_negative', 'keyword_positive', 'quotes_code', 'subagent_process',
  ].map((stratum) => [stratum, 0]));

  for (const row of corpusRows) {
    for (const stratum of row.strata) stratumCounts[stratum] += 1;
    const detectorResult = await detector.detect(row.completion);
    if (!Object.prototype.hasOwnProperty.call(statusCounts, detectorResult.status)) {
      throw new TypeError(`unknown detector status: ${detectorResult.status}`);
    }
    statusCounts[detectorResult.status] += 1;
    if (detectorResult.status !== 'ok') operationalFailures += 1;
    if (detectorResult.candidate_count === 0) zeroCandidates += 1;
    const receipts = row.tool_calls.map((call) => createEvidenceContactReceipt({
      session_id: row.session_id,
      turn_id: row.turn_id,
      tool_call_id: call.tool_call_id,
      toolCall: { provider: call.provider, name: call.name, args: call.args },
      result: resultForReceipt(call.result),
      now: new Date(call.result.observed_at || row.completed_at),
    }));
    const report = evaluateFinalization({
      completionId: row.completion_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      detectorResult,
      evidenceReceipts: receipts,
      policy,
      overrides: {},
      now: new Date(row.completed_at),
    });
    evidenceContacts += receipts.length;
    obligations += detectorResult.obligations.length;
    artifactRows.push({
      schema_version: 1,
      completion_id: row.completion_id,
      session_id: row.session_id,
      turn_id: row.turn_id,
      completion_sha256: sha256Text(row.completion),
      strata: row.strata,
      detector: detectorResult,
      evidence_receipts: receipts,
      finalization_report: report,
      label_record: labels.get(row.completion_id) || null,
      coverage: {
        sampled: true,
        keyword_candidate_count: detectorResult.candidate_count,
        zero_candidate: detectorResult.candidate_count === 0,
        detector_status: detectorResult.status,
        detector_failure: detectorResult.failure || null,
        evidence_contact_count: receipts.length,
        obligation_count: detectorResult.obligations.length,
      },
    });
  }

  const artifactText = serializeJsonl(artifactRows);
  const artifactSha256 = sha256Text(artifactText);
  const summary = {
    schema_version: 1,
    harness_version: HARNESS_VERSION,
    mode: 'coverage',
    manifest_sha256: canonicalSha(manifest),
    corpus_sha256: manifest.corpus.sha256,
    artifact_sha256: artifactSha256,
    sampled_completions: corpusRows.length,
    stratum_counts: stratumCounts,
    detector_status_counts: statusCounts,
    zero_candidate_completions: zeroCandidates,
    operational_failure_completions: operationalFailures,
    evidence_contact_count: evidenceContacts,
    obligation_count: obligations,
    labels_attached: labels.size > 0,
  };
  return { artifact_rows: artifactRows, artifact_text: artifactText, artifact_sha256: artifactSha256, summary };
}

function localOllamaUrl(value = process.env.LEADLINE_OLLAMA_URL || 'http://127.0.0.1:11434') {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama URL must use HTTP(S)');
  if (url.username || url.password) throw new Error('Ollama URL must not contain credentials');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('replay permits only localhost Ollama');
  }
  return url.toString().replace(/\/$/u, '');
}

function createLocalFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  return async (input, options = {}) => {
    localOllamaUrl(input instanceof URL ? input.toString() : String(input));
    return fetchImpl(input, { ...options, redirect: 'error' });
  };
}

async function createFrozenDetector(configBuffer, configPath, repoPath) {
  const runtime = frozenRuntime(repoPath);
  const config = JSON.parse(configBuffer.toString('utf8'));
  const identity = typeof config.model_identity === 'string'
    ? /^ollama:(.+)@[^@]+$/u.exec(config.model_identity) : null;
  if (!identity || !Number.isInteger(config.request_timeout_ms) || config.request_timeout_ms < 1) {
    throw new TypeError('frozen detector config has invalid model identity or timeout');
  }
  const llmClient = runtime.createChatClient({
    baseUrl: localOllamaUrl(),
    model: identity[1],
    timeoutMs: config.request_timeout_ms,
    fetchFn: createLocalFetch(),
  });
  return runtime.createConfiguredClaimDetector({ configPath, llmClient });
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) return { help: true };
  const command = argv[0];
  if (!['manifest', 'run'].includes(command)) throw new TypeError('command must be manifest or run');
  const values = { command };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !flag.startsWith('--') || value == null) throw new TypeError(`invalid argument: ${flag || '<missing>'}`);
    values[flag.slice(2)] = value;
  }
  const required = command === 'manifest'
    ? ['corpus', 'output', 'label-set-id', 'repo']
    : ['corpus', 'manifest', 'config', 'policy', 'output', 'summary', 'repo'];
  for (const name of required) if (!values[name]) throw new TypeError(`--${name} is required`);
  const allowed = new Set([...required, 'labels']);
  for (const name of Object.keys(values)) {
    if (name !== 'command' && !allowed.has(name)) throw new TypeError(`unknown option: --${name}`);
  }
  return values;
}

function help() {
  return `Usage:\n  node scripts/replay.js manifest --corpus FILE --output FILE --label-set-id ID --repo DIR [--labels FILE]\n  node scripts/replay.js run --corpus FILE --manifest FILE --config FILE --policy FILE --output FILE --summary FILE --repo DIR [--labels FILE]\n\nmanifest pins the frozen LL-1 components, corpus hash, optional opaque label-set hash, and overrides:{}.\nrun uses createConfiguredClaimDetector with localhost Ollama and emits per-completion artifacts plus coverage/operational counts only. It never emits precision, recall, or other scored aggregates.\n`;
}

function readOptional(file, label = 'input') {
  return file ? readRegularNoFollow(path.resolve(file), label).toString('utf8') : null;
}

function outputTarget(file) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`output path is a symlink: ${resolved}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
}

function assertPathSeparation(inputFiles, outputFiles) {
  const inputs = inputFiles.filter(Boolean).map((file) => fs.realpathSync(path.resolve(file)));
  const outputs = outputFiles.map(outputTarget);
  if (new Set(outputs).size !== outputs.length) throw new Error('output paths must be distinct');
  if (outputs.some((output) => inputs.includes(output))) throw new Error('output path must not alias an input path');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(help()); return; }
  const repoPath = path.resolve(args.repo);
  validateFrozenCheckout(repoPath);
  const runtime = frozenRuntime(repoPath);
  const { canonicalize } = runtime;
  const corpusPath = path.resolve(args.corpus);
  const labelsPath = args.labels ? path.resolve(args.labels) : null;

  if (args.command === 'manifest') {
    assertPathSeparation([corpusPath, labelsPath], [args.output]);
    const corpusText = readRegularNoFollow(corpusPath, 'corpus').toString('utf8');
    const labelsText = readOptional(labelsPath, 'labels');
    const corpusRows = readJsonlText(corpusText, 'corpus');
    const validateCorpus = schemaValidator(repoPath, 'replay-corpus.schema.json');
    validateRows(corpusRows, validateCorpus, 'corpus');
    const manifest = buildProvenanceManifest({
      corpusText, corpusRows, labelSetIdentity: args['label-set-id'], labelsText, repoPath,
    });
    writePrivate(args.output, `${canonicalize(manifest)}\n`);
    process.stdout.write(`${canonicalize({ manifest_sha256: canonicalSha(manifest, repoPath), output: path.resolve(args.output) })}\n`);
    return;
  }

  const manifestPath = path.resolve(args.manifest);
  const configPath = path.resolve(args.config);
  const policyPath = path.resolve(args.policy);
  assertPathSeparation(
    [corpusPath, manifestPath, configPath, policyPath, labelsPath],
    [args.output, args.summary],
  );
  const corpusText = readRegularNoFollow(corpusPath, 'corpus').toString('utf8');
  const labelsText = readOptional(labelsPath, 'labels');
  const manifest = JSON.parse(readRegularNoFollow(manifestPath, 'manifest').toString('utf8'));
  const corpusRows = validateManifestForCorpus(manifest, corpusText, labelsText, repoPath);
  const validateCorpus = schemaValidator(repoPath, 'replay-corpus.schema.json');
  validateRows(corpusRows, validateCorpus, 'corpus');
  const configBuffer = readFrozenInputBuffer(repoPath, configPath, 'policy/claim-detector.json');
  const policyBuffer = readFrozenInputBuffer(repoPath, policyPath, 'policy/authority.yaml');
  const staged = stagePrivateInputs(configBuffer, policyBuffer);
  let detector;
  let policy;
  try {
    detector = await createFrozenDetector(configBuffer, staged.configPath, repoPath);
    policy = runtime.loadAuthorityPolicy(staged.policyPath);
  } finally {
    staged.cleanup();
  }
  const replay = await replayRows({ corpusRows, manifest, detector, policy, labelsText });
  const validateArtifact = schemaValidator(repoPath, 'replay-artifact.schema.json');
  validateRows(replay.artifact_rows, validateArtifact, 'artifact');
  writePrivate(args.output, replay.artifact_text);
  writePrivate(args.summary, `${canonicalize(replay.summary)}\n`);
  process.stdout.write(`${canonicalize(replay.summary)}\n`);
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`replay: ${error.message}\n`); process.exitCode = 1; });
}

module.exports = {
  FROZEN,
  HARNESS_VERSION,
  assertFrozenInputFile,
  buildProvenanceManifest,
  createFrozenDetector,
  createLocalFetch,
  help,
  main,
  replayRows,
  validateFrozenCheckout,
  validateManifestForCorpus,
  writePrivate,
};
