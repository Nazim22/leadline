'use strict';

// Regression tests for issue #10 (router misses natural phrasings of the
// core "what is the current/recorded state?" question class).
// These reproduce the reported misses before the deterministic current-state
// tell family was added. Keep this file green — it encodes the receipt.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadPolicy, matchPrompt } = require('../src/matcher');

const policyPath = path.join(__dirname, '..', 'policy', 'tells.yaml');

function families(prompt) {
  const policy = loadPolicy(policyPath);
  return matchPrompt(prompt, policy).map((match) => match.family);
}

test('routes "is <component> still <verb>ing from <source>?" to runtime (issue #10 case 1)', () => {
  const f = families('does the store still read sales from the vendor archive folder?');
  assert.ok(f.includes('runtime'), `expected runtime in ${JSON.stringify(f)}`);
});

test('routes "are we dependent on <vendor> in any way?" to runtime (issue #10 case 2)', () => {
  const f = families('are we dependent on the vendor in any way?');
  assert.ok(f.includes('runtime'), `expected runtime in ${JSON.stringify(f)}`);
});

test('routes "how does our connector ingest <data> today?" to runtime (issue #10 case 3)', () => {
  const f = families('how does our connector ingest sales data today?');
  assert.ok(f.includes('runtime'), `expected runtime in ${JSON.stringify(f)}`);
});

test('routes "is our ingest still file-based or register-direct?" to runtime (issue #10 case 4)', () => {
  const f = families('is our ingest still file-based or register-direct?');
  assert.ok(f.includes('runtime'), `expected runtime in ${JSON.stringify(f)}`);
});

test('routes custom component noun "fleet-hub alive right now?" to runtime (issue #10 observation)', () => {
  const f = families('is the fleet-hub alive right now?');
  assert.ok(f.includes('runtime'), `expected runtime in ${JSON.stringify(f)}`);
});
