'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectClaims } = require('../src/claims');

test('claim candidate generator preserves repeated same-family assertions in source order', () => {
  const claims = detectClaims('The API is live. The worker is running.');
  assert.deepEqual(claims.map((claim) => claim.id), ['runtime-live', 'runtime-live']);
  assert.deepEqual(claims.map((claim) => claim.claim), ['is live. The worker is running.', 'is running.']);
});

test('claim candidate generator preserves ordered obligations across families', () => {
  const claims = detectClaims('37/37 tests pass. I fixed the bug in the handler.');
  assert.deepEqual(claims.map((claim) => claim.id), ['test-pass', 'repo-state']);
});
