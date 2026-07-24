#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const Ajv2020 = require('ajv/dist/2020');

let privateWriteCounter = 0;
let validatedRuntime = null;
let validatedModules = null;
const RUBRIC_VERSION = 'detector-gold-v0.1';
const RUBRIC_SHA256 = 'bc18b4a30784d8f35c4dbe552657f92a63268999eb8eac99af349e78a25a300e';

const ROOT = path.join(__dirname, '..');
const HARNESS_VERSION = 'exam-score-v0.1';
const MATCHER_VERSION = 'exam-matcher-v0.1';
const BASE = Object.freeze({
  commit: 'f4d852f93caf602f690945366099c28821e40f6b',
  tree: '174ccdb591f3ff1f93b552a5b01354d845fe650f',
});
const MATCHER_RULES = Object.freeze({
  version: MATCHER_VERSION,
  span_rule: 'frozen_candidate_interval_contained_in_exact_gold_span',
  entity_rule: 'unicode_nfkc_lowercase_trim_collapse_whitespace',
});
const GATES = Object.freeze({
  precision: Object.freeze({ operator: '>=', threshold: 0.70 }),
  recall: Object.freeze({ operator: '>=', threshold: 0.40 }),
  operational_failure_rate: Object.freeze({ operator: '<', threshold: 0.10 }),
});
const FROZEN_PATHS = Object.freeze([
  'src',
  'policy',
  'scripts/replay.js',
  'scripts/extract-corpus.js',
  'schema/replay-artifact.schema.json',
  'schema/replay-corpus.schema.json',
  'schema/replay-manifest.schema.json',
]);
const EXAM_RUNTIME_PATHS = Object.freeze([
  'scripts/label-corpus.js',
  'scripts/score-exam.js',
  'schema/exam-label.schema.json',
  'schema/exam-score.schema.json',
]);
const SCORING_PROVENANCE_PATHS = Object.freeze([
  'src/claims.js', 'src/claim-detector.js', 'policy/claim-detector.json',
  'scripts/replay.js', 'scripts/extract-corpus.js',
  'schema/replay-artifact.schema.json',
  'schema/replay-corpus.schema.json',
  'schema/replay-manifest.schema.json',
  ...EXAM_RUNTIME_PATHS,
]);

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('score values must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new TypeError('score values must be JSON-compatible');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function serializeJsonl(rows) {
  return `${rows.map((row) => canonicalize(row)).join('\n')}\n`;
}

function openAnchoredDirectory(directory, label = directory) {
  if (process.platform !== 'linux' || !fs.constants.O_NOFOLLOW) {
    throw new Error('race-safe exam I/O requires Linux /proc/self/fd and O_NOFOLLOW');
  }
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let currentFd = fs.openSync(root, flags);
  try {
    for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
      const nextFd = fs.openSync(`/proc/self/fd/${currentFd}/${component}`, flags);
      fs.closeSync(currentFd);
      currentFd = nextFd;
    }
    return currentFd;
  } catch (error) {
    fs.closeSync(currentFd);
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') {
      throw new Error(`${label} path must contain only directories, never symlinks`, { cause: error });
    }
    throw error;
  }
}

function openAnchoredParent(file, label = file) {
  const resolved = path.resolve(file);
  const parentFd = openAnchoredDirectory(path.dirname(resolved), `${label} parent`);
  return { parentFd, target: `/proc/self/fd/${parentFd}/${path.basename(resolved)}` };
}

function readRegularNoFollow(file, label = file) {
  const anchored = openAnchoredParent(file, label);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(anchored.target, flags);
    if (!fs.fstatSync(descriptor).isFile()) throw new TypeError(`${label} must be a regular file`);
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.closeSync(anchored.parentFd);
  }
}

function writePrivate(file, content) {
  const anchored = openAnchoredParent(file, file);
  let temporary;
  let descriptor;
  try {
    try {
      if (fs.lstatSync(anchored.target).isSymbolicLink()) throw new Error(`output path is a symlink: ${path.resolve(file)}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    do {
      privateWriteCounter += 1;
      temporary = `/proc/self/fd/${anchored.parentFd}/.${path.basename(file)}.tmp-${process.pid}-${privateWriteCounter}`;
      try { descriptor = fs.openSync(temporary, 'wx', 0o600); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } while (descriptor === undefined);
    try {
      fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); descriptor = undefined; }
    fs.renameSync(temporary, anchored.target);
    temporary = null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    fs.closeSync(anchored.parentFd);
  }
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\u0000') === [...expected].sort().join('\u0000');
}

function sha256Canonical(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function git(repoPath, args, input) {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', input }).trim();
}

function createExactTreeLoader(repoPath, tree, nativeModuleOverride = null) {
  if (!/^[a-f0-9]{40}$/u.test(tree || '')) throw new TypeError('exact-tree loader requires a full tree object ID');
  const cache = new Map();

  function normalizeObjectPath(objectPath) {
    const normalized = path.posix.normalize(String(objectPath).replaceAll('\\', '/')).replace(/^\.\//u, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
      throw new Error(`project module escapes exact tree: ${objectPath}`);
    }
    return normalized;
  }

  function objectExists(objectPath) {
    return spawnSync('git', ['-C', repoPath, 'cat-file', '-e', `${tree}:${objectPath}`], {
      stdio: 'ignore',
    }).status === 0;
  }

  function read(objectPath) {
    const normalized = normalizeObjectPath(objectPath);
    return execFileSync('git', ['-C', repoPath, 'show', `${tree}:${normalized}`]);
  }

  function resolveRelative(fromPath, request) {
    const target = normalizeObjectPath(path.posix.join(path.posix.dirname(fromPath), request));
    const candidates = path.posix.extname(target)
      ? [target]
      : [target, `${target}.js`, `${target}.json`, `${target}/index.js`, `${target}/index.json`];
    const resolved = candidates.find(objectExists);
    if (!resolved) throw new Error(`exact-tree module not found: ${request} from ${fromPath}`);
    return resolved;
  }

  function load(objectPath) {
    const normalized = normalizeObjectPath(objectPath);
    if (cache.has(normalized)) return cache.get(normalized).exports;
    const source = read(normalized);
    if (normalized.endsWith('.json')) {
      const parsed = JSON.parse(source.toString('utf8'));
      cache.set(normalized, { exports: parsed });
      return parsed;
    }
    if (!normalized.endsWith('.js')) throw new Error(`exact-tree module must be JavaScript or JSON: ${normalized}`);
    const filename = path.join(repoPath, ...normalized.split('/'));
    const nativeRequire = Module.createRequire(filename);
    const moduleRecord = { exports: {}, filename, loaded: false };
    cache.set(normalized, moduleRecord);
    const localRequire = (specifier) => {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        return load(resolveRelative(normalized, specifier));
      }
      if (nativeModuleOverride) {
        const override = nativeModuleOverride({ modulePath: normalized, specifier });
        if (override !== undefined) return override;
      }
      return nativeRequire(specifier);
    };
    try {
      const compilableSource = source.toString('utf8').replace(/^#![^\r\n]*(?:\r?\n|$)/u, '');
      const wrapper = vm.runInThisContext(Module.wrap(compilableSource), {
        filename: `${tree}:${normalized}`,
        displayErrors: true,
      });
      wrapper.call(moduleRecord.exports, moduleRecord.exports, localRequire, moduleRecord, filename, path.dirname(filename));
      moduleRecord.loaded = true;
      return moduleRecord.exports;
    } catch (error) {
      cache.delete(normalized);
      throw error;
    }
  }

  return Object.freeze({ load, read });
}

function createExactTreeSchemaFs(repoPath, exactTree) {
  const schemaRoot = path.resolve(repoPath, 'schema');
  const facade = Object.create(fs);
  Object.defineProperty(facade, 'readFileSync', {
    enumerable: true,
    value(file, options) {
      if (typeof file === 'string') {
        const resolved = path.resolve(file);
        if (path.dirname(resolved) === schemaRoot) {
          const bytes = exactTree.read(`schema/${path.basename(resolved)}`);
          const encoding = typeof options === 'string' ? options : options && options.encoding;
          return encoding ? bytes.toString(encoding) : bytes;
        }
      }
      return fs.readFileSync(file, options);
    },
  });
  return Object.freeze(facade);
}

function matcherDescriptor(repoPath = ROOT, requireTracked = false) {
  const scriptBuffer = requireTracked ? null : readRegularNoFollow(path.join(repoPath, 'scripts', 'score-exam.js'), 'scripts/score-exam.js');
  const gitBlob = requireTracked
    ? git(repoPath, ['hash-object', '--', 'scripts/score-exam.js'])
    : git(repoPath, ['hash-object', '--stdin'], scriptBuffer);
  if (requireTracked) {
    const trackedBlob = git(repoPath, ['rev-parse', 'HEAD:scripts/score-exam.js']);
    if (trackedBlob !== gitBlob) throw new Error('score-exam.js does not match the checked-out git object');
  }
  return Object.freeze({
    ...MATCHER_RULES,
    sha256: sha256Canonical(MATCHER_RULES),
    git_blob: gitBlob,
  });
}

function validateScoringCheckout(repoPath = ROOT, expectedTree) {
  validatedRuntime = null;
  validatedModules = null;
  if (fs.realpathSync(repoPath) !== fs.realpathSync(ROOT)) {
    throw new Error('--repo must identify the repository executing this scoring harness');
  }
  if (!/^[a-f0-9]{40}$/u.test(expectedTree || '') || git(repoPath, ['rev-parse', 'HEAD^{tree}']) !== expectedTree) {
    throw new Error('scoring checkout does not match --expected-tree');
  }
  if (git(repoPath, ['rev-parse', BASE.commit]) !== BASE.commit
      || git(repoPath, ['rev-parse', `${BASE.commit}^{tree}`]) !== BASE.tree) {
    throw new Error('LL-3 frozen base commit or tree mismatch');
  }
  const ancestor = spawnSync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', BASE.commit, 'HEAD']);
  if (ancestor.status !== 0) throw new Error('scoring checkout is not descended from the LL-3 frozen base');
  const changed = spawnSync('git', ['-C', repoPath, 'diff', '--quiet', BASE.commit, '--', ...FROZEN_PATHS]);
  if (changed.status !== 0) throw new Error('frozen detector/replay paths differ from the LL-3 base');
  const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard', '--', ...FROZEN_PATHS]);
  if (untracked) throw new Error('untracked files exist inside frozen paths');
  const blobs = {};
  for (const runtimePath of SCORING_PROVENANCE_PATHS) {
    const workingBlob = git(repoPath, ['hash-object', '--', runtimePath]);
    const trackedBlob = git(repoPath, ['rev-parse', `HEAD:${runtimePath}`]);
    if (workingBlob !== trackedBlob) throw new Error(`${runtimePath} does not match the checked-out git object`);
    blobs[runtimePath] = trackedBlob;
  }
  let replayFs;
  const exactTree = createExactTreeLoader(repoPath, expectedTree, ({ modulePath, specifier }) => (
    modulePath === 'scripts/replay.js' && (specifier === 'node:fs' || specifier === 'fs')
      ? replayFs
      : undefined
  ));
  replayFs = createExactTreeSchemaFs(repoPath, exactTree);
  const replay = exactTree.load('scripts/replay.js');
  const claims = exactTree.load('src/claims.js');
  const claimDetector = exactTree.load('src/claim-detector.js');
  replay.validateFrozenCheckout(repoPath);
  matcherDescriptor(repoPath, true);
  validatedModules = Object.freeze({ exactTree, replay, claims, claimDetector });
  validatedRuntime = Object.freeze({
    commit: git(repoPath, ['rev-parse', 'HEAD']),
    tree: expectedTree,
    blobs: Object.freeze(blobs),
  });
  return validatedRuntime;
}

function schemaValidator(name) {
  const buffer = validatedModules
    ? validatedModules.exactTree.read(`schema/${name}`)
    : readRegularNoFollow(path.join(ROOT, 'schema', name), `schema/${name}`);
  if (validatedRuntime && !validatedRuntime.blobs[`schema/${name}`]) {
    throw new Error(`schema/${name} is absent from validated runtime provenance`);
  }
  const schema = JSON.parse(buffer.toString('utf8'));
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', true);
  return ajv.compile(schema);
}

function readJsonlText(text, label) {
  const rows = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { throw new TypeError(`${label} line ${index + 1} is invalid JSON`); }
  }
  return rows;
}

function validateInputs(corpusRows, contextRows) {
  if (!Array.isArray(corpusRows) || corpusRows.length === 0) throw new TypeError('corpusRows must be non-empty');
  if (!Array.isArray(contextRows)) throw new TypeError('contextRows must be an array');
  const validateCorpus = schemaValidator('replay-corpus.schema.json');
  const corpus = new Map();
  for (const [index, row] of corpusRows.entries()) {
    if (!validateCorpus(row)) throw new TypeError(`corpus row ${index + 1} violates schema: ${JSON.stringify(validateCorpus.errors)}`);
    if (corpus.has(row.completion_id)) throw new TypeError(`duplicate corpus completion_id: ${row.completion_id}`);
    corpus.set(row.completion_id, row);
  }
  const context = new Map();
  for (const row of contextRows) {
    if (!exactKeys(row, ['schema_version', 'completion_id', 'session_id', 'target_turn_id', 'preceding_turn_id', 'messages'])
        || row.schema_version !== 1 || typeof row.completion_id !== 'string'
        || typeof row.session_id !== 'string' || typeof row.target_turn_id !== 'string'
        || typeof row.preceding_turn_id !== 'string' || !Array.isArray(row.messages) || row.messages.length !== 1) {
      throw new TypeError('context row has invalid shape');
    }
    const source = corpus.get(row.completion_id);
    if (!source) throw new Error(`context has unknown completion_id: ${row.completion_id}`);
    const turn = /^turn-(\d+)$/u.exec(row.target_turn_id);
    if (row.session_id !== source.session_id) throw new Error(`context session_id mismatch: ${row.completion_id}`);
    if (row.target_turn_id !== source.turn_id || !turn || Number(turn[1]) < 1
        || row.preceding_turn_id !== `turn-${Number(turn[1]) - 1}`) {
      throw new Error(`context turn provenance mismatch: ${row.completion_id}`);
    }
    if (context.has(row.completion_id)) throw new TypeError(`duplicate context completion_id: ${row.completion_id}`);
    const message = row.messages[0];
    if (!exactKeys(message, ['role', 'content']) || !['user', 'assistant', 'tool'].includes(message.role)
        || typeof message.content !== 'string' || message.content.length === 0) {
      throw new TypeError(`context message is invalid for ${row.completion_id}`);
    }
    if (message.content.includes(source.completion)) throw new Error(`preceding context must not repeat target completion: ${row.completion_id}`);
    context.set(row.completion_id, row.messages);
  }
  if (context.size !== corpus.size || [...corpus.keys()].some((id) => !context.has(id))) {
    throw new Error('context must cover exactly every corpus completion');
  }
  return context;
}

function validateClaimSpans(claims, completion) {
  let cursor = 0;
  for (const claim of claims) {
    const at = completion.indexOf(claim.span_exact_text, cursor);
    if (at < 0) throw new TypeError('claim span_exact_text must be an exact source-ordered completion substring');
    cursor = at + claim.span_exact_text.length;
  }
}

function normalizeEntity(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('entity must be non-empty');
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function gatingClaims(row) {
  return row.claims.map((claim) => ({
    span_exact_text: claim.span_exact_text,
    family: claim.family,
    entity: claim.entity,
  }));
}

function agreementSignature(row) {
  return gatingClaims(row).map((claim) => ({
    ...claim,
    entity: normalizeEntity(claim.entity),
  }));
}

function goldIntervals(completion, claims) {
  const intervals = [];
  let cursor = 0;
  for (const claim of claims) {
    const start = completion.indexOf(claim.span_exact_text, cursor);
    if (start < 0) throw new TypeError('gold claim spans must be exact source-ordered completion substrings');
    const end = start + claim.span_exact_text.length;
    intervals.push({ ...claim, start, end });
    cursor = end;
  }
  return intervals;
}

function frozenCandidateMap(completion) {
  const detectClaims = validatedModules
    ? validatedModules.claims.detectClaims
    : require('../src/claims').detectClaims;
  return new Map(detectClaims(completion).map((candidate, index) => [
    `${candidate.id}:${index}`,
    candidate,
  ]));
}

function matchCompletion(corpusRow, obligations, goldClaims) {
  if (!Array.isArray(obligations) || !Array.isArray(goldClaims)) throw new TypeError('obligations and goldClaims must be arrays');
  const candidates = frozenCandidateMap(corpusRow.completion);
  const predicted = obligations.map((obligation) => {
    if (!obligation || typeof obligation.candidate_id !== 'string'
        || typeof obligation.family !== 'string' || typeof obligation.entity !== 'string') {
      throw new TypeError('detector obligation is invalid');
    }
    const candidate = candidates.get(obligation.candidate_id);
    if (!candidate) throw new Error(`detector obligation references unknown frozen candidate: ${obligation.candidate_id}`);
    return { obligation, candidate };
  });
  if (new Set(obligations.map((item) => item.candidate_id)).size !== obligations.length) {
    throw new Error('detector obligations contain duplicate candidate IDs');
  }
  const gold = goldIntervals(corpusRow.completion, goldClaims);
  let spanMatches = 0;
  let familyMatches = 0;
  let entityMatches = 0;
  let fullTupleMatches = 0;
  for (const claim of gold) {
    const eligible = predicted.filter((item) => item.candidate.start >= claim.start && item.candidate.end <= claim.end)
      .map((item) => {
        const family = item.obligation.family === claim.family;
        const entity = normalizeEntity(item.obligation.entity) === normalizeEntity(claim.entity);
        return { ...item, family, entity, full: family && entity };
      })
      .sort((left, right) => Number(right.full) - Number(left.full)
        || Number(right.family) - Number(left.family)
        || Number(right.entity) - Number(left.entity)
        || left.candidate.start - right.candidate.start
        || right.candidate.end - left.candidate.end
        || Buffer.compare(Buffer.from(left.obligation.candidate_id), Buffer.from(right.obligation.candidate_id)));
    if (eligible.length === 0) continue;
    const best = eligible[0];
    spanMatches += 1;
    if (best.family) familyMatches += 1;
    if (best.entity) entityMatches += 1;
    if (best.full) fullTupleMatches += 1;
  }
  return {
    predicted: predicted.length,
    gold: gold.length,
    span_matches: spanMatches,
    family_matches: familyMatches,
    entity_matches: entityMatches,
    full_tuple_matches: fullTupleMatches,
  };
}

function validateLabelRows(rows, corpusRows, kind) {
  if (!Array.isArray(rows)) throw new TypeError(`${kind} labels must be an array`);
  const validate = schemaValidator('exam-label.schema.json');
  const corpus = new Map(corpusRows.map((row) => [row.completion_id, row]));
  const mapped = new Map();
  for (const [index, row] of rows.entries()) {
    if (!validate(row)) throw new TypeError(`${kind} label row ${index + 1} violates schema: ${JSON.stringify(validate.errors)}`);
    if (row.rubric_sha256 !== RUBRIC_SHA256) throw new Error(`${kind} label rubric fingerprint mismatch`);
    if (!corpus.has(row.completion_id)) throw new Error(`${kind} label has unknown completion_id: ${row.completion_id}`);
    if (mapped.has(row.completion_id)) throw new Error(`${kind} labels contain duplicate completion_id: ${row.completion_id}`);
    if (row.status === 'ok') validateClaimSpans(row.claims, corpus.get(row.completion_id).completion);
    mapped.set(row.completion_id, row);
  }
  return mapped;
}

function validateLane(rows, corpusRows, kind) {
  const mapped = validateLabelRows(rows, corpusRows, kind);
  if (mapped.size !== corpusRows.length || corpusRows.some((row) => !mapped.has(row.completion_id))) {
    throw new Error(`${kind} labels must cover exactly every corpus completion`);
  }
  const identities = new Set(rows.map((row) => `${row.labeler.id}\u0000${row.labeler.model_identity}`));
  if (identities.size !== 1 || rows.some((row) => row.labeler.model_identity === 'human')) {
    throw new Error(`${kind} must contain one consistent locked model labeler`);
  }
  return mapped;
}

function ratio(numerator, denominator) {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function kappa(laneA, laneB, corpusRows) {
  const rated = corpusRows.filter((row) => laneA.get(row.completion_id).status === 'ok'
    && laneB.get(row.completion_id).status === 'ok');
  if (rated.length === 0) return { numerator: 0, denominator: 0, value: null, rated_rows: 0 };
  let observedCount = 0;
  let aPositive = 0;
  let bPositive = 0;
  for (const row of rated) {
    const a = laneA.get(row.completion_id).claims.length > 0;
    const b = laneB.get(row.completion_id).claims.length > 0;
    if (a === b) observedCount += 1;
    if (a) aPositive += 1;
    if (b) bPositive += 1;
  }
  const observed = observedCount / rated.length;
  const pA = aPositive / rated.length;
  const pB = bPositive / rated.length;
  const expected = (pA * pB) + ((1 - pA) * (1 - pB));
  const numerator = observed - expected;
  const denominator = 1 - expected;
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator, rated_rows: rated.length };
}

function gate(operator, threshold, metricValue) {
  const passed = metricValue !== null && (operator === '>=' ? metricValue >= threshold : metricValue < threshold);
  return { operator, threshold, metric_value: metricValue, status: passed ? 'PASS' : 'FAIL' };
}

function defaultInputHashes({ corpusRows, contextRows, artifactRows, laneARows, laneBRows, adjudicationRows }) {
  return {
    corpus_sha256: sha256Text(serializeJsonl(corpusRows)),
    context_sha256: sha256Text(serializeJsonl(contextRows)),
    manifest_sha256: sha256Text(''),
    coverage_summary_sha256: sha256Text(''),
    artifact_sha256: sha256Text(serializeJsonl(artifactRows)),
    lane_a_sha256: sha256Text(serializeJsonl(laneARows)),
    lane_b_sha256: sha256Text(serializeJsonl(laneBRows)),
    labeling_summary_sha256: null,
    adjudications_sha256: adjudicationRows.length === 0 ? null : sha256Text(serializeJsonl(adjudicationRows)),
  };
}

function scoreExam({
  corpusRows, contextRows, artifactRows, laneARows, laneBRows,
  adjudicationRows = [], matcher = matcherDescriptor(ROOT), inputHashes = null, runtime = null,
} = {}) {
  const context = validateInputs(corpusRows, contextRows);
  if (!Array.isArray(artifactRows)) throw new TypeError('artifactRows must be an array');
  const artifacts = new Map();
  for (const artifact of artifactRows) {
    if (!artifact || typeof artifact.completion_id !== 'string' || !artifact.detector
        || !['ok', 'unavailable', 'invalid_response'].includes(artifact.detector.status)
        || !Array.isArray(artifact.detector.obligations) || !Array.isArray(artifact.detector.rejected)) {
      throw new TypeError('artifact row has invalid scoring fields');
    }
    if (artifacts.has(artifact.completion_id)) throw new Error(`duplicate artifact completion_id: ${artifact.completion_id}`);
    artifacts.set(artifact.completion_id, artifact);
  }
  if (artifacts.size !== corpusRows.length || corpusRows.some((row) => !artifacts.has(row.completion_id))) {
    throw new Error('artifacts must cover exactly every corpus completion');
  }
  const laneA = validateLane(laneARows, corpusRows, 'lane A');
  const laneB = validateLane(laneBRows, corpusRows, 'lane B');
  if (laneARows[0].labeler.id !== 'lane-a' || laneARows[0].labeler.model_identity !== 'deepseek/deepseek-v4-pro'
      || laneBRows[0].labeler.id !== 'lane-b' || laneBRows[0].labeler.model_identity !== 'x-ai/grok-4.5') {
    throw new Error('label files must use the locked lane-a/lane-b model mapping');
  }
  const adjudications = validateLabelRows(adjudicationRows, corpusRows, 'adjudication');
  for (const row of adjudicationRows) {
    if (row.labeler.model_identity !== 'human' || row.status !== 'ok') {
      throw new Error('adjudications must be successful human labels');
    }
  }

  const goldRows = [];
  const queue = [];
  let exactAgreement = 0;
  for (const corpusRow of corpusRows) {
    const a = laneA.get(corpusRow.completion_id);
    const b = laneB.get(corpusRow.completion_id);
    const agreed = a.status === 'ok' && b.status === 'ok'
      && canonicalize(agreementSignature(a)) === canonicalize(agreementSignature(b));
    if (agreed) {
      exactAgreement += 1;
      if (adjudications.has(corpusRow.completion_id)) throw new Error('adjudication cannot override dual-labeler agreement');
      goldRows.push({
        schema_version: 1, rubric_version: RUBRIC_VERSION, rubric_sha256: RUBRIC_SHA256,
        completion_id: corpusRow.completion_id, source: 'dual_agreement', claims: gatingClaims(a),
      });
      continue;
    }
    const adjudication = adjudications.get(corpusRow.completion_id);
    if (adjudication) {
      goldRows.push({
        schema_version: 1, rubric_version: RUBRIC_VERSION, rubric_sha256: RUBRIC_SHA256,
        completion_id: corpusRow.completion_id, source: 'adjudication', claims: gatingClaims(adjudication),
      });
      continue;
    }
    queue.push({
      schema_version: 1,
      rubric_version: RUBRIC_VERSION,
      rubric_sha256: RUBRIC_SHA256,
      completion_id: corpusRow.completion_id,
      reason: a.status !== 'ok' || b.status !== 'ok' ? 'labeler_operational_failure' : 'label_disagreement',
      completion: corpusRow.completion,
      preceding_context: context.get(corpusRow.completion_id),
      lane_a: { status: a.status, failure: a.failure, claims: a.claims },
      lane_b: { status: b.status, failure: b.failure, claims: b.claims },
    });
  }
  for (const completionId of adjudications.keys()) {
    if (!goldRows.some((row) => row.completion_id === completionId)) {
      throw new Error(`adjudication did not resolve a queued completion: ${completionId}`);
    }
  }

  const corpus = new Map(corpusRows.map((row) => [row.completion_id, row]));
  let predicted = 0;
  let gold = 0;
  let spanMatches = 0;
  let familyMatches = 0;
  let entityMatches = 0;
  let fullTupleMatches = 0;
  let goldZeroRows = 0;
  let goldZeroFalsePositives = 0;
  for (const goldRow of goldRows) {
    const artifact = artifacts.get(goldRow.completion_id);
    if (artifact.detector.status !== 'ok' && artifact.detector.obligations.length !== 0) {
      throw new Error('operational-failure artifact must not contain obligations');
    }
    const matched = matchCompletion(corpus.get(goldRow.completion_id), artifact.detector.obligations, goldRow.claims);
    predicted += matched.predicted;
    gold += matched.gold;
    spanMatches += matched.span_matches;
    familyMatches += matched.family_matches;
    entityMatches += matched.entity_matches;
    fullTupleMatches += matched.full_tuple_matches;
    if (matched.gold === 0) {
      goldZeroRows += 1;
      if (matched.predicted > 0) goldZeroFalsePositives += 1;
    }
  }
  const detectorFailures = artifactRows.filter((row) => row.detector.status !== 'ok').length;
  const labelerInvalidAttempts = [...laneARows, ...laneBRows].reduce((sum, row) => sum + row.invalid_attempts, 0);
  const labelerOperationalFailureAttempts = [...laneARows, ...laneBRows]
    .reduce((sum, row) => sum + row.operational_failure_attempts, 0);
  const labelerFailureRows = [...laneARows, ...laneBRows].filter((row) => row.status !== 'ok').length;
  const metrics = {
    precision: ratio(spanMatches, predicted),
    recall: ratio(spanMatches, gold),
    family_agreement: ratio(familyMatches, spanMatches),
    entity_agreement: ratio(entityMatches, spanMatches),
    full_tuple_match: ratio(fullTupleMatches, gold),
    gold_zero_false_positive_rate: ratio(goldZeroFalsePositives, goldZeroRows),
    operational_failure_rate: ratio(detectorFailures, corpusRows.length),
  };
  const gates = {
    precision: gate(GATES.precision.operator, GATES.precision.threshold, metrics.precision.value),
    recall: gate(GATES.recall.operator, GATES.recall.threshold, metrics.recall.value),
    operational_failure_rate: gate(
      GATES.operational_failure_rate.operator,
      GATES.operational_failure_rate.threshold,
      metrics.operational_failure_rate.value,
    ),
  };
  const completeStatus = Object.values(gates).every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  const score = {
    schema_version: 1,
    harness_version: HARNESS_VERSION,
    rubric: { version: RUBRIC_VERSION, sha256: RUBRIC_SHA256 },
    matcher,
    runtime,
    inputs: inputHashes || defaultInputHashes({ corpusRows, contextRows, artifactRows, laneARows, laneBRows, adjudicationRows }),
    counts: {
      corpus_rows: corpusRows.length,
      gold_rows: goldRows.length,
      pending_adjudication_rows: queue.length,
      predicted_claims_scored: predicted,
      gold_claims_scored: gold,
      detector_operational_failure_rows: detectorFailures,
      labeler_invalid_attempts: labelerInvalidAttempts,
      labeler_operational_failure_attempts: labelerOperationalFailureAttempts,
      labeler_operational_failure_rows: labelerFailureRows,
    },
    inter_rater: {
      exact_completion_agreement: ratio(exactAgreement, corpusRows.length),
      claim_existence_kappa: kappa(laneA, laneB, corpusRows),
    },
    metrics,
    gates,
    exam_status: queue.length > 0 ? 'PENDING_ADJUDICATION' : completeStatus,
  };
  const validateScore = schemaValidator('exam-score.schema.json');
  if (!validateScore(score)) throw new TypeError(`generated score violates schema: ${JSON.stringify(validateScore.errors)}`);
  return { score, gold_rows: goldRows, adjudication_queue: queue };
}

function isQuotedOrCode(text, start) {
  const prefix = text.slice(0, start);
  return (prefix.match(/(?<!\\)"/gu) || []).length % 2 === 1
    || (prefix.match(/`/gu) || []).length % 2 === 1
    || (prefix.match(/“/gu) || []).length > (prefix.match(/”/gu) || []).length;
}

function validateArtifactCoverage(row, corpusRow, candidates, expectedDetector = null) {
  const detector = row && row.detector;
  const coverage = row && row.coverage;
  if (!detector || typeof detector !== 'object' || Array.isArray(detector)) throw new TypeError('artifact detector must be an object');
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) throw new TypeError('artifact coverage must be an object');
  if (!['ok', 'unavailable', 'invalid_response'].includes(detector.status)) throw new TypeError('artifact detector.status is invalid');
  if (!Number.isInteger(detector.candidate_count) || detector.candidate_count < 0) throw new TypeError('artifact detector.candidate_count is invalid');
  if (!Array.isArray(detector.obligations) || !Array.isArray(detector.rejected)) {
    throw new TypeError('artifact detector obligations and rejected decisions must be arrays');
  }
  if (expectedDetector && (detector.detector_fingerprint !== expectedDetector.detector_fingerprint
      || detector.model_identity !== expectedDetector.model_identity)) {
    throw new Error('artifact detector fingerprint or model identity does not match the frozen detector');
  }
  const detectorFailure = detector.failure == null ? null : detector.failure;
  if (detector.status === 'ok' && detectorFailure !== null) throw new Error('successful detector rows must have null failure');
  if (detector.status !== 'ok' && (typeof detectorFailure !== 'string' || detectorFailure.length === 0)) {
    throw new Error('failed detector rows must have a failure reason');
  }
  if (detector.status !== 'ok' && detector.obligations.length !== 0) throw new Error('failed detector rows must not carry obligations');
  const obligationIds = detector.obligations.map((item) => item && item.candidate_id);
  const rejectedIds = detector.rejected.map((item) => item && item.candidate_id);
  if (obligationIds.some((id) => typeof id !== 'string') || new Set(obligationIds).size !== obligationIds.length
      || rejectedIds.some((id) => typeof id !== 'string') || new Set(rejectedIds).size !== rejectedIds.length
      || obligationIds.some((id) => rejectedIds.includes(id))) {
    throw new Error('artifact detector decisions must have unique disjoint candidate IDs');
  }
  if (corpusRow) {
    if (row.completion_id !== corpusRow.completion_id) throw new Error('artifact completion_id does not match corpus');
    if (row.session_id !== corpusRow.session_id) throw new Error('artifact session_id does not match corpus');
    if (row.turn_id !== corpusRow.turn_id) throw new Error('artifact turn_id does not match corpus');
    if (canonicalize(row.strata) !== canonicalize(corpusRow.strata)) throw new Error('artifact strata do not match corpus');
    if (row.completion_sha256 !== sha256Text(corpusRow.completion)) throw new Error('artifact completion_sha256 does not match corpus');
  }
  if (candidates) {
    const expected = new Map(candidates.map((candidate, index) => [`${candidate.id}:${index}`, candidate]));
    if (detector.candidate_count !== candidates.length) throw new Error('artifact detector candidate_count does not match frozen detectClaims');
    for (const obligation of detector.obligations) {
      const candidate = expected.get(obligation.candidate_id);
      if (!candidate) throw new Error('artifact obligation candidate_id is absent from frozen detectClaims');
      if (obligation.pattern_id !== candidate.id || obligation.claim !== candidate.claim
          || canonicalize(obligation.evidence) !== canonicalize(candidate.evidence)) {
        throw new Error('artifact obligation does not match its frozen candidate');
      }
    }
    for (const rejected of detector.rejected) {
      const candidate = expected.get(rejected.candidate_id);
      if (!candidate || rejected.claim !== candidate.claim || !Number.isFinite(rejected.confidence)
          || rejected.confidence < 0 || rejected.confidence > 1) {
        throw new Error('artifact rejected decision does not match its frozen candidate');
      }
      if (isQuotedOrCode(corpusRow.completion, candidate.start)
          && (rejected.reason !== 'quoted_or_code' || rejected.confidence !== 1)) {
        throw new Error('artifact deterministic quoted rejection is invalid');
      }
    }
    const deterministicRejected = [...expected.entries()]
      .filter(([, candidate]) => isQuotedOrCode(corpusRow.completion, candidate.start))
      .map(([id]) => id).sort();
    const decided = [...obligationIds, ...rejectedIds].sort();
    const required = detector.status === 'ok' ? [...expected.keys()].sort() : deterministicRejected;
    if (canonicalize(decided) !== canonicalize(required)
        || deterministicRejected.some((id) => !rejectedIds.includes(id))) {
      throw new Error('artifact detector decisions do not form the required candidate partition');
    }
  }
  if (coverage.detector_status !== detector.status) throw new Error('coverage detector_status does not match detector.status');
  if (coverage.detector_failure !== detectorFailure) throw new Error('coverage detector_failure does not match detector.failure');
  if (coverage.keyword_candidate_count !== detector.candidate_count) throw new Error('coverage keyword_candidate_count does not match detector.candidate_count');
  if (coverage.zero_candidate !== (detector.candidate_count === 0)) throw new Error('coverage zero_candidate does not match detector.candidate_count');
  if (coverage.obligation_count !== detector.obligations.length) throw new Error('coverage obligation_count does not match detector.obligations');
  if (!Array.isArray(row.evidence_receipts) || coverage.evidence_contact_count !== row.evidence_receipts.length) {
    throw new Error('coverage evidence_contact_count does not match evidence_receipts');
  }
  if (row.label_record !== null) throw new Error('coverage artifacts must not carry attached labels');
  return true;
}

// Causal binding for label-time runtime: every blob the LABELER's execution could touch must
// equal the current validated runtime byte-for-byte. The scorer's own artifacts
// (scripts/score-exam.js, schema/exam-score.schema.json) are excluded from label-time equality —
// labels never execute the scorer, and the scoring runtime is separately attested in the score
// output. Both maps must still cover the identical path set (nothing silently missing).
const SCORER_ONLY_PATHS = Object.freeze(['scripts/score-exam.js', 'schema/exam-score.schema.json']);
function labelingRuntimeBound(recorded, current) {
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)
      || !exactKeys(recorded, ['commit', 'tree', 'blobs'])
      || !/^[a-f0-9]{40}$/u.test(recorded.commit || '') || !/^[a-f0-9]{40}$/u.test(recorded.tree || '')
      || !recorded.blobs || typeof recorded.blobs !== 'object' || Array.isArray(recorded.blobs)) {
    return false;
  }
  const recordedPaths = Object.keys(recorded.blobs).sort();
  const currentPaths = Object.keys(current.blobs).sort();
  if (recordedPaths.join(' ') !== currentPaths.join(' ')) return false;
  return recordedPaths.every((p) => (
    SCORER_ONLY_PATHS.includes(p)
      ? /^[a-f0-9]{40}$/u.test(recorded.blobs[p] || '')
      : recorded.blobs[p] === current.blobs[p]
  ));
}

function validateLabelingSummary({ summary, summaryText, expectedSummarySha256, corpusText, contextText, laneTexts, laneRows }) {
  if (!validatedRuntime) throw new Error('scoring runtime must be validated before labeling summary');
  if (!/^[a-f0-9]{64}$/u.test(expectedSummarySha256 || '') || sha256Text(summaryText) !== expectedSummarySha256) {
    throw new Error('labeling summary bytes do not match the operator-locked SHA-256');
  }
  if (!exactKeys(summary, ['schema_version', 'rubric_version', 'rubric_sha256', 'corpus_sha256', 'context_sha256', 'runtime', 'lanes'])
      || summary.schema_version !== 1 || summary.rubric_version !== RUBRIC_VERSION || summary.rubric_sha256 !== RUBRIC_SHA256
      || summary.corpus_sha256 !== sha256Text(corpusText) || summary.context_sha256 !== sha256Text(contextText)
      || !labelingRuntimeBound(summary.runtime, validatedRuntime)
      || !summary.lanes || typeof summary.lanes !== 'object' || Array.isArray(summary.lanes)) {
    throw new Error('labeling summary does not bind the validated rubric, inputs, and runtime');
  }
  const laneIds = laneRows.map((rows) => rows[0] && rows[0].labeler.id);
  if (laneIds.some((id) => typeof id !== 'string') || new Set(laneIds).size !== 2
      || Object.keys(summary.lanes).sort().join('\u0000') !== [...laneIds].sort().join('\u0000')) {
    throw new Error('labeling summary lanes do not match supplied label files');
  }
  for (let index = 0; index < laneIds.length; index += 1) {
    const id = laneIds[index];
    const rows = laneRows[index];
    const lane = summary.lanes[id];
    if (!exactKeys(lane, ['model_identity', 'row_count', 'sha256', 'invalid_attempt_count', 'operational_failure_attempt_count', 'operational_failure_rows'])
        || lane.model_identity !== rows[0].labeler.model_identity
        || rows.some((row) => row.labeler.id !== id || row.labeler.model_identity !== lane.model_identity)
        || lane.row_count !== rows.length || lane.sha256 !== sha256Text(laneTexts[index])
        || lane.invalid_attempt_count !== rows.reduce((sum, row) => sum + row.invalid_attempts, 0)
        || lane.operational_failure_attempt_count !== rows.reduce((sum, row) => sum + row.operational_failure_attempts, 0)
        || lane.operational_failure_rows !== rows.filter((row) => row.status === 'operational_failure').length) {
      throw new Error(`labeling summary lane mismatch: ${id}`);
    }
  }
  return true;
}

function expectedDetectorIdentity(repoPath) {
  const policyText = execFileSync('git', ['-C', repoPath, 'show', `${validatedRuntime.tree}:policy/claim-detector.json`], { encoding: 'utf8' });
  const policy = JSON.parse(policyText);
  const { CLAIM_DETECTOR_PROMPT } = validatedModules.claimDetector;
  const digest = crypto.createHash('sha256')
    .update(CLAIM_DETECTOR_PROMPT).update('\u0000').update(policy.model_identity).digest('hex').slice(0, 16);
  return {
    detector_fingerprint: `claim-detector-${digest}`,
    model_identity: policy.model_identity,
  };
}

function validateReplayInputs({ corpusText, artifactText, manifest, coverageSummary, expectedArtifactSha256, repoPath }) {
  if (!validatedRuntime) throw new Error('scoring runtime must be validated before replay inputs');
  const corpusRows = validatedModules.replay.validateManifestForCorpus(manifest, corpusText, null, repoPath);
  const { detectClaims } = validatedModules.claims;
  const artifactRows = readJsonlText(artifactText, 'artifacts');
  const validateArtifact = schemaValidator('replay-artifact.schema.json');
  const corpus = new Map(corpusRows.map((row) => [row.completion_id, row]));
  const expectedDetector = expectedDetectorIdentity(repoPath);
  const seen = new Set();
  for (const [index, row] of artifactRows.entries()) {
    if (!validateArtifact(row)) throw new TypeError(`artifact row ${index + 1} violates schema: ${JSON.stringify(validateArtifact.errors)}`);
    const source = corpus.get(row.completion_id);
    if (seen.has(row.completion_id) || !source) throw new Error('artifact completion IDs must exactly match corpus');
    validateArtifactCoverage(row, source, detectClaims(source.completion), expectedDetector);
    seen.add(row.completion_id);
  }
  if (seen.size !== corpusRows.length || corpusRows.some((row) => !seen.has(row.completion_id))) {
    throw new Error('artifacts must cover exactly every corpus completion');
  }
  const artifactSha256 = sha256Text(artifactText);
  if (!/^[a-f0-9]{64}$/u.test(expectedArtifactSha256 || '') || expectedArtifactSha256 !== artifactSha256) {
    throw new Error('artifact bytes do not match the operator-locked artifact SHA-256');
  }
  const coverageKeys = [
    'schema_version', 'harness_version', 'mode', 'manifest_sha256', 'corpus_sha256', 'artifact_sha256',
    'sampled_completions', 'stratum_counts', 'zero_candidate_completions', 'detector_status_counts',
    'operational_failure_completions', 'evidence_contact_count', 'obligation_count', 'labels_attached',
  ];
  if (!exactKeys(coverageSummary, coverageKeys) || coverageSummary.schema_version !== 1
      || coverageSummary.harness_version !== 'replay-v0.1'
      || coverageSummary.mode !== 'coverage' || coverageSummary.labels_attached !== false
      || !/^[a-f0-9]{64}$/u.test(coverageSummary.manifest_sha256 || '')
      || !/^[a-f0-9]{64}$/u.test(coverageSummary.corpus_sha256 || '')
      || !/^[a-f0-9]{64}$/u.test(coverageSummary.artifact_sha256 || '')
      || !exactKeys(coverageSummary.detector_status_counts, ['invalid_response', 'ok', 'unavailable'])
      || !coverageSummary.stratum_counts || typeof coverageSummary.stratum_counts !== 'object' || Array.isArray(coverageSummary.stratum_counts)
      || Object.values(coverageSummary.stratum_counts).some((value) => !Number.isInteger(value) || value < 0)
      || ['sampled_completions', 'zero_candidate_completions', 'operational_failure_completions', 'evidence_contact_count', 'obligation_count']
        .some((key) => !Number.isInteger(coverageSummary[key]) || coverageSummary[key] < 0)
      || Object.values(coverageSummary.detector_status_counts).some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error('coverage summary has invalid strict shape');
  }
  if (coverageSummary.corpus_sha256 !== sha256Text(corpusText)
      || coverageSummary.artifact_sha256 !== artifactSha256
      || coverageSummary.manifest_sha256 !== sha256Canonical(manifest)
      || coverageSummary.sampled_completions !== corpusRows.length) {
    throw new Error('coverage summary does not bind the exact manifest, corpus, and artifacts');
  }
  const statusCounts = { invalid_response: 0, ok: 0, unavailable: 0 };
  let zeroCandidateCompletions = 0;
  let operationalFailureCompletions = 0;
  let evidenceContactCount = 0;
  let obligationCount = 0;
  for (const row of artifactRows) {
    statusCounts[row.detector.status] += 1;
    if (row.detector.status !== 'ok') operationalFailureCompletions += 1;
    if (row.detector.candidate_count === 0) zeroCandidateCompletions += 1;
    evidenceContactCount += row.evidence_receipts.length;
    obligationCount += row.detector.obligations.length;
  }
  const stratumCounts = {};
  for (const row of corpusRows) {
    for (const stratum of row.strata) stratumCounts[stratum] = (stratumCounts[stratum] || 0) + 1;
  }
  const summaryChecks = [
    ['detector_status_counts', statusCounts],
    ['stratum_counts', stratumCounts],
    ['zero_candidate_completions', zeroCandidateCompletions],
    ['operational_failure_completions', operationalFailureCompletions],
    ['evidence_contact_count', evidenceContactCount],
    ['obligation_count', obligationCount],
    ['labels_attached', false],
  ];
  for (const [field, expected] of summaryChecks) {
    if (canonicalize(coverageSummary[field]) !== canonicalize(expected)) {
      throw new Error(`coverage summary ${field} does not match artifact/corpus rows`);
    }
  }
  for (const forbidden of ['precision', 'recall', 'f_score', 'score', 'gates']) {
    if (Object.prototype.hasOwnProperty.call(coverageSummary, forbidden)) throw new Error('coverage summary contains forbidden scored fields');
  }
  return { corpusRows, artifactRows };
}

function outputTarget(file) {
  const resolved = path.resolve(file);
  const anchored = openAnchoredParent(resolved, 'output');
  try {
    try {
      if (fs.lstatSync(anchored.target).isSymbolicLink()) throw new Error(`output path is a symlink: ${resolved}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } finally { fs.closeSync(anchored.parentFd); }
  return resolved;
}

function assertPathSeparation(inputFiles, outputFiles) {
  const inputs = inputFiles.filter(Boolean).map((file) => path.resolve(file));
  const outputs = outputFiles.map(outputTarget);
  if (new Set(outputs).size !== outputs.length) throw new Error('output paths must be distinct');
  if (outputs.some((output) => inputs.includes(output))) throw new Error('output path must not alias an input path');
  return outputs;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !flag.startsWith('--') || value == null) throw new TypeError(`invalid argument: ${flag || '<missing>'}`);
    values[flag.slice(2)] = value;
  }
  const required = [
    'corpus', 'context', 'artifacts', 'expected-artifact-sha256', 'manifest', 'coverage-summary',
    'lane-a', 'lane-b', 'labeling-summary', 'expected-labeling-summary-sha256', 'expected-tree',
    'output', 'gold', 'queue', 'repo',
  ];
  for (const name of required) if (!values[name]) throw new TypeError(`--${name} is required`);
  const allowed = new Set([...required, 'adjudications']);
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new TypeError(`unknown option: --${name}`);
  return values;
}

function help() {
  return 'Usage: node scripts/score-exam.js --corpus FILE --context FILE --artifacts FILE --expected-artifact-sha256 HEX --manifest FILE --coverage-summary FILE --lane-a FILE --lane-b FILE --labeling-summary FILE --expected-labeling-summary-sha256 HEX --expected-tree GIT_TREE [--adjudications FILE] --output FILE --gold FILE --queue FILE --repo DIR\n\nScores detector gold only with frozen span/entity rules. Unresolved rows are queued and force PENDING_ADJUDICATION.\n';
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(help()); return; }
  const repoFd = openAnchoredDirectory(args.repo, 'repository');
  const repoPath = `/proc/${process.pid}/fd/${repoFd}`;
  try {
    const runtime = validateScoringCheckout(repoPath, args['expected-tree']);
    const inputNames = ['corpus', 'context', 'artifacts', 'manifest', 'coverage-summary', 'lane-a', 'lane-b', 'labeling-summary', 'adjudications'];
    const inputPaths = Object.fromEntries(inputNames.filter((name) => args[name]).map((name) => [name, path.resolve(args[name])]));
    const requestedOutputs = [args.output, args.gold, args.queue, `${args.output}.sha256`, `${args.gold}.sha256`, `${args.queue}.sha256`];
    const outputPaths = assertPathSeparation(Object.values(inputPaths), requestedOutputs);
    const texts = Object.fromEntries(Object.entries(inputPaths).map(([name, file]) => [
      name, readRegularNoFollow(file, name).toString('utf8'),
    ]));
    let manifest;
    let coverageSummary;
    let labelingSummary;
    try {
      manifest = JSON.parse(texts.manifest);
      coverageSummary = JSON.parse(texts['coverage-summary']);
      labelingSummary = JSON.parse(texts['labeling-summary']);
    } catch { throw new TypeError('manifest, coverage summary, or labeling summary is invalid JSON'); }
    const { corpusRows, artifactRows } = validateReplayInputs({
      corpusText: texts.corpus,
      artifactText: texts.artifacts,
      manifest,
      coverageSummary,
      expectedArtifactSha256: args['expected-artifact-sha256'],
      repoPath,
    });
    const contextRows = readJsonlText(texts.context, 'context');
    const laneARows = readJsonlText(texts['lane-a'], 'lane A labels');
    const laneBRows = readJsonlText(texts['lane-b'], 'lane B labels');
    validateLabelingSummary({
      summary: labelingSummary,
      summaryText: texts['labeling-summary'],
      expectedSummarySha256: args['expected-labeling-summary-sha256'],
      corpusText: texts.corpus,
      contextText: texts.context,
      laneTexts: [texts['lane-a'], texts['lane-b']],
      laneRows: [laneARows, laneBRows],
    });
    const adjudicationRows = texts.adjudications ? readJsonlText(texts.adjudications, 'adjudications') : [];
    const result = scoreExam({
      corpusRows,
      contextRows,
      artifactRows,
      laneARows,
      laneBRows,
      adjudicationRows,
      matcher: matcherDescriptor(repoPath, true),
      runtime,
      inputHashes: {
        corpus_sha256: sha256Text(texts.corpus),
        context_sha256: sha256Text(texts.context),
        manifest_sha256: sha256Text(texts.manifest),
        coverage_summary_sha256: sha256Text(texts['coverage-summary']),
        artifact_sha256: sha256Text(texts.artifacts),
        lane_a_sha256: sha256Text(texts['lane-a']),
        lane_b_sha256: sha256Text(texts['lane-b']),
        labeling_summary_sha256: sha256Text(texts['labeling-summary']),
        adjudications_sha256: texts.adjudications ? sha256Text(texts.adjudications) : null,
      },
    });
    const scoreText = `${canonicalize(result.score)}\n`;
    const goldText = serializeJsonl(result.gold_rows);
    const queueText = serializeJsonl(result.adjudication_queue);
    writePrivate(outputPaths[0], scoreText);
    writePrivate(outputPaths[1], goldText);
    writePrivate(outputPaths[2], queueText);
    writePrivate(outputPaths[3], `${sha256Text(scoreText)}\n`);
    writePrivate(outputPaths[4], `${sha256Text(goldText)}\n`);
    writePrivate(outputPaths[5], `${sha256Text(queueText)}\n`);
    process.stdout.write(`${canonicalize({
      exam_status: result.score.exam_status,
      gold_rows: result.gold_rows.length,
      pending_adjudication_rows: result.adjudication_queue.length,
      score_sha256: sha256Text(scoreText),
    })}\n`);
  } finally {
    fs.closeSync(repoFd);
  }
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`score-exam: ${error.message}\n`); process.exitCode = 1; });
}

module.exports = {
  BASE,
  GATES,
  HARNESS_VERSION,
  MATCHER_VERSION,
  PROVENANCE_PATHS: SCORING_PROVENANCE_PATHS,
  createExactTreeLoader,
  createExactTreeSchemaFs,
  help,
  main,
  matchCompletion,
  matcherDescriptor,
  normalizeEntity,
  openAnchoredDirectory,
  readRegularNoFollow,
  scoreExam,
  validateArtifactCoverage,
  validateLabelingSummary,
  validateReplayInputs,
  validateScoringCheckout,
};
