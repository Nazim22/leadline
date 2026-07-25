#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
let extractionRuntimeCache = null;
let privateWriteCounter = 0;

const EXTRACTION_RUNTIME = Object.freeze({
  version: 'extraction-runtime-v2',
  entries: Object.freeze(['src/receipts.js', 'src/claims.js', 'src/evidence.js']),
  blobs: Object.freeze({
    'src/capability.js': Object.freeze({
      git_blob: '41160296cf91fe6c97293da8247c19653367c5bb',
      sha256: '40a110a3c120c298b398de477fb63d147a5aa2d8f64e5d0cd986d15ffd5f09a7',
    }),
    'src/claims.js': Object.freeze({
      git_blob: '3aa8352239a81c45850a7b9dca9a4a153274728f',
      sha256: 'fba5fa3719704caf6065640503cffb9e9e549fd32fbac7eac974be35abdb737e',
    }),
    'src/entity-match.js': Object.freeze({
      git_blob: 'bd9f752986d5076d257e388426763bee78e26868',
      sha256: 'af0a211393e94c8f3abff612b5421f71c1b5d08d92818e9b1fb514c7cd27efdd',
    }),
    'src/evidence.js': Object.freeze({
      git_blob: '22a60c1df5f82644c470138f7ac50c0ea13b1acf',
      sha256: '3334559a118c1714183687a88aebc42998ee26dd7c5870f73036299c615d04c7',
    }),
    'src/receipts.js': Object.freeze({
      git_blob: 'ec509af77e3182eefad7678287c799ec2d849b67',
      sha256: 'dff3f1b020b493356984ee5b1d4acdeb8f48dbfdaceba9f7a2d1ba50babab60d',
    }),
  }),
});

const STRATA = Object.freeze([
  'keyword_positive', 'keyword_negative', 'quotes_code', 'subagent_process',
]);

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function readRegularNoFollow(file, label = file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags);
    if (!fs.fstatSync(descriptor).isFile()) throw new TypeError(`${label} must be a regular file`);
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function localRequireSpecifiers(source) {
  const specifiers = [];
  const pattern = /\brequire\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/gu;
  for (const match of source.matchAll(pattern)) specifiers.push(match[2]);
  return specifiers;
}

function resolveLocalRequire(repo, fromRelative, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), specifier));
  if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) {
    throw new Error(`local require escapes runtime root: ${fromRelative} -> ${specifier}`);
  }
  const candidates = path.posix.extname(base)
    ? [base]
    : [base, `${base}.js`, `${base}.json`, `${base}/index.js`, `${base}/index.json`];
  for (const relative of candidates) {
    const file = path.join(repo, relative);
    try {
      if (fs.lstatSync(file).isFile()) return relative;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`unresolved local require: ${fromRelative} -> ${specifier}`);
}

function discoverLocalRequireClosure(repoPath, entries) {
  const repo = fs.realpathSync(repoPath);
  const pending = [...entries];
  const closure = new Set();
  while (pending.length > 0) {
    const relative = pending.shift();
    if (closure.has(relative)) continue;
    const source = readRegularNoFollow(path.join(repo, relative), relative);
    closure.add(relative);
    if (!relative.endsWith('.js')) continue;
    for (const specifier of localRequireSpecifiers(source.toString('utf8'))) {
      const dependency = resolveLocalRequire(repo, relative, specifier);
      if (!closure.has(dependency)) pending.push(dependency);
    }
  }
  return closure;
}

function gitBlobSha1(bytes) {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function snapshotRuntimeManifest(repoPath, manifest) {
  const repo = fs.realpathSync(repoPath);
  const expectedPaths = Object.keys(manifest.blobs).sort();
  const actualPaths = [...discoverLocalRequireClosure(repo, manifest.entries)].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`runtime closure does not match ${manifest.version}`);
  }
  const sources = new Map();
  for (const relative of expectedPaths) {
    const bytes = readRegularNoFollow(path.join(repo, relative), relative);
    const expected = manifest.blobs[relative];
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (gitBlobSha1(bytes) !== expected.git_blob || sha256 !== expected.sha256) {
      throw new Error(`${relative} does not match ${manifest.version}`);
    }
    sources.set(relative, bytes);
  }
  return Object.freeze({ manifest, sources });
}

function createExactSourceLoader(repoPath, sources) {
  const repo = fs.realpathSync(repoPath);
  const nativeRequire = Module.createRequire(path.join(repo, 'scripts', 'extract-corpus.js'));
  const cache = new Map();

  function resolve(parent, request) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(parent), request));
    if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) {
      throw new Error(`local require escapes runtime root: ${parent} -> ${request}`);
    }
    const candidates = path.posix.extname(base)
      ? [base]
      : [base, `${base}.js`, `${base}.json`, `${base}/index.js`, `${base}/index.json`];
    const resolved = candidates.find((candidate) => sources.has(candidate));
    if (!resolved) throw new Error(`unverified local require: ${parent} -> ${request}`);
    return resolved;
  }

  function load(relative) {
    if (!sources.has(relative)) throw new Error(`source is outside the verified runtime: ${relative}`);
    if (cache.has(relative)) return cache.get(relative).exports;
    const bytes = sources.get(relative);
    const filename = path.join(repo, relative);
    const moduleRecord = { exports: {}, filename, id: relative, loaded: false };
    cache.set(relative, moduleRecord);
    try {
      if (relative.endsWith('.json')) {
        moduleRecord.exports = JSON.parse(bytes.toString('utf8'));
        moduleRecord.loaded = true;
        return moduleRecord.exports;
      }
      let source = bytes.toString('utf8');
      if (source.startsWith('#!')) source = source.replace(/^#!.*(?:\r?\n|$)/u, '');
      const exactFs = Object.create(fs);
      Object.defineProperty(exactFs, 'readFileSync', {
        value(file, options) {
          if (path.resolve(String(file)) === path.resolve(filename)) {
            const encoding = typeof options === 'string' ? options : options && options.encoding;
            return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
          }
          return fs.readFileSync(file, options);
        },
      });
      const localRequire = (request) => {
        if (request.startsWith('./') || request.startsWith('../')) return load(resolve(relative, request));
        if (request === 'fs' || request === 'node:fs') return exactFs;
        return nativeRequire(request);
      };
      localRequire.resolve = nativeRequire.resolve;
      const wrapper = vm.runInThisContext(Module.wrap(source), { filename });
      wrapper.call(
        moduleRecord.exports,
        moduleRecord.exports,
        localRequire,
        moduleRecord,
        filename,
        path.dirname(filename),
      );
      moduleRecord.loaded = true;
      return moduleRecord.exports;
    } catch (error) {
      cache.delete(relative);
      throw error;
    }
  }

  return Object.freeze({ load });
}

function verifyRuntimeManifest(repoPath, manifest) {
  return snapshotRuntimeManifest(repoPath, manifest).manifest;
}

function verifyExtractionRuntime(repoPath = ROOT) {
  const repo = fs.realpathSync(repoPath);
  if (repo !== fs.realpathSync(ROOT)) throw new Error('--repo must identify the extraction harness checkout');
  return verifyRuntimeManifest(repo, EXTRACTION_RUNTIME);
}

function extractionRuntime(repoPath = ROOT) {
  if (extractionRuntimeCache) return extractionRuntimeCache;
  const repo = fs.realpathSync(repoPath);
  if (repo !== fs.realpathSync(ROOT)) throw new Error('--repo must identify the extraction harness checkout');
  const snapshot = snapshotRuntimeManifest(repo, EXTRACTION_RUNTIME);
  const loader = createExactSourceLoader(repo, snapshot.sources);
  extractionRuntimeCache = Object.freeze({
    canonicalize: loader.load('src/receipts.js').canonicalize,
    detectClaims: loader.load('src/claims.js').detectClaims,
    redactSecrets: loader.load('src/evidence.js').redactSecrets,
  });
  return extractionRuntimeCache;
}

function writePrivate(file, content) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`output path is a symlink: ${resolved}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let temporary;
  let descriptor;
  do {
    privateWriteCounter += 1;
    temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.tmp-${process.pid}-${privateWriteCounter}`);
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } while (descriptor === undefined);
  try {
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, resolved);
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function stableId(prefix, ...parts) {
  return `${prefix}-${sha256Text(parts.join('\u0000')).slice(0, 24)}`;
}

function serializeJsonl(rows) {
  const { canonicalize } = extractionRuntime();
  return `${rows.map((row) => canonicalize(row)).join('\n')}\n`;
}

function parseQuotas(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('--quotas must be non-empty');
  const quotas = {};
  for (const item of value.split(',')) {
    const match = /^([a-z_]+)=(\d+)$/u.exec(item.trim());
    if (!match || !STRATA.includes(match[1]) || Object.prototype.hasOwnProperty.call(quotas, match[1])) {
      throw new TypeError(`invalid quota: ${item}`);
    }
    quotas[match[1]] = Number(match[2]);
  }
  if (Object.keys(quotas).length !== STRATA.length || STRATA.some((stratum) => !Number.isInteger(quotas[stratum]))) {
    throw new TypeError(`--quotas must specify exactly: ${STRATA.join(',')}`);
  }
  if (Object.values(quotas).every((quota) => quota === 0)) throw new RangeError('at least one quota must be positive');
  return Object.freeze(quotas);
}

function sanitize(value) {
  const { redactSecrets } = extractionRuntime();
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function contentBlocks(event) {
  return event && event.message && Array.isArray(event.message.content) ? event.message.content : [];
}

function validIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function structured(source, snake, camel = null) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  if (Object.prototype.hasOwnProperty.call(source, snake)) return source[snake];
  if (camel && Object.prototype.hasOwnProperty.call(source, camel)) return source[camel];
  return undefined;
}

function firstStructured(sources, snake, camel = null) {
  for (const source of sources) {
    const value = structured(source, snake, camel);
    if (value !== undefined) return value;
  }
  return undefined;
}

function integerOrNull(value, { minimum = null, maximum = null } = {}) {
  if (!Number.isInteger(value)) return null;
  if (minimum != null && value < minimum) return null;
  if (maximum != null && value > maximum) return null;
  return value;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function toolIdentity(rawName) {
  const original = String(rawName || 'unknown');
  const lowered = original.toLowerCase();
  if (['bash', 'read', 'glob', 'grep'].includes(lowered)) return { provider: lowered, name: lowered };
  if (lowered.startsWith('mcp__')) return { provider: lowered, name: lowered.split('__').at(-1) };
  return { provider: lowered, name: lowered };
}

function normalizedToolResult(block, event) {
  const { redactSecrets } = extractionRuntime();
  const blockResult = block && block.result;
  const eventResult = event && event.toolUseResult;
  const sources = [block, blockResult, eventResult];
  const explicitValue = firstStructured(sources, 'value');
  const rawValue = explicitValue !== undefined
    ? explicitValue
    : eventResult !== undefined ? eventResult : block.content;
  const rawError = firstStructured(sources, 'error');
  const observed = firstStructured(sources, 'observed_at', 'observedAt');
  return {
    value: sanitize(rawValue == null ? '' : rawValue),
    error: rawError == null ? null : redactSecrets(String(rawError)),
    exit_code: integerOrNull(firstStructured(sources, 'exit_code', 'exitCode')),
    is_error: booleanOrNull(firstStructured(sources, 'is_error', 'isError')),
    http_status: integerOrNull(firstStructured(sources, 'http_status', 'httpStatus'), { minimum: 100, maximum: 599 }),
    executed_test_count: integerOrNull(
      firstStructured(sources, 'executed_test_count', 'executedTestCount'), { minimum: 0 },
    ),
    observed_at: validIso(observed) || validIso(event.timestamp),
    truncated: firstStructured(sources, 'truncated') === true,
  };
}

function listJsonlFiles(root) {
  const found = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareBytes(left.name, right.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  }
  visit(root);
  return found;
}

function strataFor(text) {
  const { detectClaims } = extractionRuntime();
  const strata = [detectClaims(text).length > 0 ? 'keyword_positive' : 'keyword_negative'];
  if (/`|```|[“”"]/u.test(text)) strata.push('quotes_code');
  if (/\b(?:subagent|worker|background|process|job|task)\b/iu.test(text)) strata.push('subagent_process');
  return STRATA.filter((stratum) => strata.includes(stratum));
}

function parseTranscript(file, root, seed) {
  const { redactSecrets } = extractionRuntime();
  const relative = path.relative(root, file).split(path.sep).join('/');
  const sessionId = stableId('session', seed, relative);
  const lines = readRegularNoFollow(file, file).toString('utf8').split('\n');
  const rows = [];
  let turnNumber = 0;
  let currentTurn = null;
  let turnCalls = [];
  let pendingCompletion = null;
  const callsByRawId = new Map();
  const flushCompletion = () => {
    if (pendingCompletion) rows.push(pendingCompletion);
    pendingCompletion = null;
  };

  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const blocks = contentBlocks(event);
    const resultBlocks = blocks.filter((block) => block && block.type === 'tool_result');
    const humanText = event.type === 'user' && resultBlocks.length === 0 ? extractText(event.message && event.message.content) : '';
    if (humanText.trim()) {
      flushCompletion();
      turnNumber += 1;
      currentTurn = `turn-${turnNumber}`;
      turnCalls = [];
      callsByRawId.clear();
    }
    if (!currentTurn) continue;

    if (event.type === 'assistant') {
      const uses = blocks.filter((block) => block && block.type === 'tool_use');
      if (uses.length > 0) pendingCompletion = null;
      for (const block of uses) {
        const rawId = String(block.id || stableId('raw-tool', seed, relative, currentTurn, String(lineIndex), String(turnCalls.length)));
        const identity = toolIdentity(block.name);
        const call = {
          tool_call_id: stableId('tool', seed, relative, rawId),
          provider: identity.provider,
          name: identity.name,
          args: sanitize(block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {}),
          result: {
            value: '', error: null, exit_code: null, is_error: null, http_status: null,
            executed_test_count: null, observed_at: null, truncated: false,
          },
        };
        turnCalls.push(call);
        callsByRawId.set(rawId, call);
      }
      const text = redactSecrets(extractText(event.message && event.message.content)).trim();
      if (text && uses.length === 0) {
        const completedAt = validIso(event.timestamp);
        if (!completedAt) continue;
        pendingCompletion = {
          schema_version: 1,
          completion_id: stableId('completion', seed, sessionId, currentTurn, String(lineIndex), String(event.uuid || ''), text),
          session_id: sessionId,
          turn_id: currentTurn,
          completed_at: completedAt,
          completion: text,
          strata: strataFor(text),
          tool_calls: sanitize(turnCalls),
        };
      }
    }

    for (const block of resultBlocks) {
      const call = callsByRawId.get(String(block.tool_use_id || ''));
      if (call) call.result = normalizedToolResult(block, event);
    }
  }
  flushCompletion();
  return rows;
}

function extractCorpusRows({ transcriptsDir, seed, quotas } = {}) {
  if (typeof transcriptsDir !== 'string' || transcriptsDir.length === 0) throw new TypeError('transcriptsDir must be non-empty');
  if (!fs.statSync(transcriptsDir).isDirectory()) throw new TypeError('transcriptsDir must be a directory');
  if (typeof seed !== 'string' || seed.length === 0) throw new TypeError('seed must be non-empty');
  if (!quotas || STRATA.some((stratum) => !Number.isInteger(quotas[stratum]) || quotas[stratum] < 0)) {
    throw new TypeError('quotas must contain non-negative integers for every stratum');
  }
  const candidates = listJsonlFiles(transcriptsDir)
    .flatMap((file) => parseTranscript(file, transcriptsDir, seed));
  const selected = new Map();
  for (const stratum of STRATA) {
    const eligible = candidates
      .filter((row) => row.strata.includes(stratum))
      .sort((left, right) => {
        const leftScore = sha256Text(`${seed}\u0000${stratum}\u0000${left.completion_id}`);
        const rightScore = sha256Text(`${seed}\u0000${stratum}\u0000${right.completion_id}`);
        return compareBytes(leftScore, rightScore) || compareBytes(left.completion_id, right.completion_id);
      });
    if (eligible.length < quotas[stratum]) {
      throw new RangeError(`quota ${stratum}=${quotas[stratum]} exceeds available=${eligible.length}`);
    }
    for (const row of eligible.slice(0, quotas[stratum])) selected.set(row.completion_id, row);
  }
  return [...selected.values()].sort((left, right) => compareBytes(left.completion_id, right.completion_id));
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--transcripts', '--output', '--seed', '--quotas'].includes(flag) || value == null) {
      throw new TypeError(`invalid argument: ${flag || '<missing>'}`);
    }
    values[flag.slice(2)] = value;
  }
  for (const required of ['transcripts', 'output', 'seed', 'quotas']) {
    if (!values[required]) throw new TypeError(`--${required} is required`);
  }
  return values;
}

function help() {
  return `Usage: node scripts/extract-corpus.js --transcripts DIR --output FILE --seed STRING --quotas SPEC\n\nSPEC must set all strata, for example:\n  keyword_positive=50,keyword_negative=50,quotes_code=25,subagent_process=25\n\nWrites canonical sanitized JSONL plus FILE.sha256. No random or clock defaults are used.\n`;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(help()); return; }
  const { canonicalize } = extractionRuntime();
  const quotas = parseQuotas(args.quotas);
  const transcriptsDir = fs.realpathSync(path.resolve(args.transcripts));
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const outputTarget = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  if (outputTarget === transcriptsDir || outputTarget.startsWith(`${transcriptsDir}${path.sep}`)) {
    throw new Error('--output must be outside --transcripts');
  }
  const rows = extractCorpusRows({ transcriptsDir, seed: args.seed, quotas });
  const text = serializeJsonl(rows);
  const hash = sha256Text(text);
  writePrivate(output, text);
  writePrivate(`${output}.sha256`, `${hash}  ${path.basename(output)}\n`);
  process.stdout.write(`${canonicalize({ corpus_sha256: hash, output, row_count: rows.length })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`extract-corpus: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  EXTRACTION_RUNTIME,
  STRATA,
  compareBytes,
  createExactSourceLoader,
  discoverLocalRequireClosure,
  extractCorpusRows,
  help,
  main,
  parseQuotas,
  parseTranscript,
  readRegularNoFollow,
  serializeJsonl,
  sha256Text,
  snapshotRuntimeManifest,
  verifyExtractionRuntime,
  verifyRuntimeManifest,
  writePrivate,
};
