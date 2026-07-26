'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const packageJson = require(path.join(__dirname, '..', 'package.json'));

test('published package includes the benchmark corpora used by the bench command', () => {
  assert.ok(packageJson.files.includes('bench'));
});

test('package root exposes the V0 measurement API', () => {
  const leadline = require('..');

  assert.equal(typeof leadline.decompose, 'function');
  assert.equal(typeof leadline.loadPolicy, 'function');
  assert.equal(typeof leadline.matchPrompt, 'function');
  assert.equal(typeof leadline.createPlanner, 'function');
  assert.equal(typeof leadline.evaluateSatisfaction, 'function');
  assert.equal(typeof leadline.runBenchmark, 'function');
});

test('package root exposes the Phase A claim-enforcement API', () => {
  const leadline = require('..');
  for (const name of [
    'appendFinalizationReport', 'appendReceipt', 'createClaimObligationDetector',
    'evaluateFinalization', 'loadAuthorityPolicy', 'requiredCapabilities',
    'createEvidenceContactReceipt', 'validateEvidenceReceipt', 'deriveCapability', 'matchEntity',
  ]) {
    assert.equal(typeof leadline[name], 'function', `${name} must be exported`);
  }
});
