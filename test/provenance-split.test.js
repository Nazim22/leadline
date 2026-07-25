'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EXPECTED_EXTRACTION_CLOSURE = [
  'src/capability.js',
  'src/claims.js',
  'src/entity-match.js',
  'src/evidence.js',
  'src/receipts.js',
];
const {
  EXTRACTION_RUNTIME,
  createExactSourceLoader,
  discoverLocalRequireClosure,
  serializeJsonl,
  snapshotRuntimeManifest,
  verifyExtractionRuntime,
  verifyRuntimeManifest,
} = require('../scripts/extract-corpus');
const {
  FROZEN,
  createFrozenReplayRuntime,
  schemaValidator,
  serializeReplayJsonl,
  verifyFrozenReplayRuntime,
} = require('../scripts/replay');

function gitBlobSha1(bytes) {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function copyExtractionRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-extraction-runtime-'));
  for (const relative of EXPECTED_EXTRACTION_CLOSURE) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  return root;
}

test('extraction-runtime-v2 manifest equals the complete transitive local require closure', () => {
  assert.equal(EXTRACTION_RUNTIME.version, 'extraction-runtime-v2');
  assert.deepEqual(Object.keys(EXTRACTION_RUNTIME.blobs).sort(), EXPECTED_EXTRACTION_CLOSURE);
  assert.deepEqual(
    [...discoverLocalRequireClosure(ROOT, EXTRACTION_RUNTIME.entries)].sort(),
    EXPECTED_EXTRACTION_CLOSURE,
  );
  assert.doesNotThrow(() => verifyExtractionRuntime(ROOT));
});

test('unrelated source additions do not invalidate extraction-runtime-v2', () => {
  const root = copyExtractionRuntime();
  fs.writeFileSync(path.join(root, 'src', 'unrelated.js'), "'use strict';\nmodule.exports = 1;\n");
  assert.doesNotThrow(() => verifyRuntimeManifest(root, EXTRACTION_RUNTIME));
});

test('changing a causal extraction-runtime blob fails closed', () => {
  const root = copyExtractionRuntime();
  fs.appendFileSync(path.join(root, 'src', 'receipts.js'), '\n// changed\n');
  assert.throws(
    () => verifyRuntimeManifest(root, EXTRACTION_RUNTIME),
    /src\/receipts\.js does not match extraction-runtime-v2/,
  );
});

test('an unmanifested transitive local require fails closure verification', () => {
  const root = copyExtractionRuntime();
  fs.writeFileSync(path.join(root, 'src', 'unmanifested.js'), "'use strict';\nmodule.exports = 1;\n");
  fs.appendFileSync(path.join(root, 'src', 'evidence.js'), "\nrequire('./unmanifested');\n");
  assert.throws(
    () => verifyRuntimeManifest(root, EXTRACTION_RUNTIME),
    /runtime closure does not match extraction-runtime-v2/,
  );
});

test('extraction runtime ignores poisoned native require cache entries', () => {
  const receiptsPath = require.resolve('../src/receipts');
  const previous = require.cache[receiptsPath];
  require.cache[receiptsPath] = {
    id: receiptsPath,
    filename: receiptsPath,
    loaded: true,
    exports: { canonicalize: () => 'POISONED-CACHED-BYTES' },
  };
  try {
    assert.notEqual(serializeJsonl([{ ok: true }]), 'POISONED-CACHED-BYTES\n');
  } finally {
    if (previous) require.cache[receiptsPath] = previous;
    else delete require.cache[receiptsPath];
  }
});

test('a verified extraction snapshot executes captured bytes after checkout mutation', () => {
  const root = copyExtractionRuntime();
  const snapshot = snapshotRuntimeManifest(root, EXTRACTION_RUNTIME);
  fs.appendFileSync(path.join(root, 'src', 'receipts.js'), '\nthrow new Error("MUTATED-AFTER-VERIFY");\n');
  const loader = createExactSourceLoader(root, snapshot.sources);
  assert.equal(loader.load('src/receipts.js').canonicalize({ ok: true }), '{"ok":true}');
});

test('historical replay loads the exact 8488cb3 capability blob, never changed checkout bytes', () => {
  assert.equal(FROZEN.commit, '8488cb333157208e9781f8d3c32ea0dda587a368');
  assert.doesNotThrow(() => verifyFrozenReplayRuntime(ROOT));
  const runtime = createFrozenReplayRuntime(ROOT);
  const frozenBlob = execFileSync('git', [
    '-C', ROOT, 'rev-parse', `${FROZEN.commit}:src/capability.js`,
  ], { encoding: 'utf8' }).trim();
  const checkoutBytes = fs.readFileSync(path.join(ROOT, 'src', 'capability.js'));
  assert.equal(runtime.loaded_project_blobs['src/capability.js'], frozenBlob);
  assert.notEqual(gitBlobSha1(checkoutBytes), frozenBlob);
});

test('historical replay serialization never loads checkout capability through require cache', () => {
  const capabilityPath = require.resolve('../src/capability');
  const previous = require.cache[capabilityPath];
  delete require.cache[capabilityPath];
  try {
    assert.equal(serializeReplayJsonl([{ ok: true }]), '{"ok":true}\n');
    assert.equal(require.cache[capabilityPath], undefined);
  } finally {
    if (previous) require.cache[capabilityPath] = previous;
  }
});

test('historical replay schemas do not read mutable checkout schema bytes', () => {
  const original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (String(file).includes(`${path.sep}schema${path.sep}`)) {
      throw new Error('MUTABLE-CHECKOUT-SCHEMA-READ');
    }
    return original(file, ...args);
  };
  try {
    assert.equal(typeof schemaValidator(ROOT, 'replay-manifest.schema.json'), 'function');
  } finally {
    fs.readFileSync = original;
  }
});
