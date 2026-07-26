'use strict';

// Regression tests for issue #10 direction #3: project-registerable component
// nouns behave like the built-in 'API' noun for runtime probing when paired
// with a live/recorded-state qualifier.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadPolicy, matchPrompt } = require('../src/matcher');

const policyPath = path.join(__dirname, '..', 'policy', 'tells.yaml');

test('custom component noun + state qualifier routes to runtime', () => {
  const policy = loadPolicy(policyPath);
  const f = matchPrompt('is the fleet-hub alive right now?', policy).map((m) => m.family);
  assert.ok(f.includes('runtime'), `expected runtime in ${JSON.stringify(f)}`);
});

test('registered noun alone (no qualifier) does NOT route', () => {
  const policy = loadPolicy(policyPath);
  const f = matchPrompt('what is the fleet-hub', policy).map((m) => m.family);
  assert.ok(!f.includes('runtime'), `expected no runtime in ${JSON.stringify(f)}`);
});

test('"store still read" routes to runtime via registered noun', () => {
  const policy = loadPolicy(policyPath);
  const f = matchPrompt('does the store still read sales?', policy).map((m) => m.family);
  assert.ok(f.includes('runtime'), `expected runtime in ${JSON.stringify(f)}`);
});

test('absent glossary means no component-noun matches (backward compatible)', () => {
  const policy = { tells: [], negatives: [], componentNouns: [] };
  const f = matchPrompt('is the fleet-hub alive right now?', policy).map((m) => m.family);
  assert.deepEqual(f, []);
});
