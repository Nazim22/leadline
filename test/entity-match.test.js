'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchEntity, ENTITY_MATCHER_VERSION, entityMatcherSha } = require('../src/entity-match');

test('matcher is versioned', () => {
  assert.equal(ENTITY_MATCHER_VERSION, 'entmatch-v0.2');
  assert.match(entityMatcherSha(), /^[a-f0-9]{64}$/);
});

test('atomic identifier matches exactly; generic tokens are ignored', () => {
  const r = matchEntity('cstoregenie-app lambda', ['cstoregenie-app', 'is', 'live']);
  assert.equal(r.matched, true);
  assert.equal(r.method, 'atomic');
  assert.deepEqual(r.matched_terms, ['cstoregenie-app']);
});

test('qualified dotted symbol and path are preserved as atomic identifiers', () => {
  assert.equal(matchEntity('Foo.bar', ['foo.bar', 'called']).matched, true);
  assert.equal(matchEntity('src/app/index.js', ['src/app/index.js']).matched, true);
});

test('multi-token entity matches in any order when all discriminative tokens are present', () => {
  const r = matchEntity('user auth', ['auth', 'the', 'user']);
  assert.equal(r.matched, true);
  assert.equal(r.method, 'all_tokens');
});

test('partial token presence does not match; unmatched terms are reported', () => {
  const r = matchEntity('user auth flow', ['user', 'flow']); // 'auth' missing
  assert.equal(r.matched, false);
  assert.equal(r.method, 'none');
  assert.ok(r.unmatched_terms.includes('auth'));
});

test('generic-only entities never match (api / service collisions)', () => {
  assert.equal(matchEntity('api', ['api', 'is', 'live']).matched, false);
  assert.equal(matchEntity('the service', ['service', 'up']).matched, false);
});

test('two similarly named services are distinguished by their atomic id', () => {
  assert.equal(matchEntity('orders-api', ['orders-worker', 'started']).matched, false);
  assert.equal(matchEntity('orders-api', ['orders-api', 'ok']).matched, true);
});

test('a matching identifier in unrelated diagnostic text still matches (documented residual risk, auditable)', () => {
  const r = matchEntity('cstoregenie-app', ['cstoregenie-app', 'appears', 'in', 'an', 'error', 'trace']);
  assert.equal(r.matched, true);
  assert.equal(r.method, 'atomic');
  assert.deepEqual(r.matched_terms, ['cstoregenie-app']);
});

test('truncation flag is passed through so a non-match against a capped set is treated as ambiguous upstream', () => {
  const r = matchEntity('zzz-not-present', ['a', 'b'], { truncated: true });
  assert.equal(r.matched, false);
  assert.equal(r.truncated, true);
});
