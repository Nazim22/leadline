'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSatisfaction } = require('../src/satisfaction');

const base = {
  requires_nonempty: true,
  requires_relevance_to: ['performSync'],
  freshness: 'any',
};

test('empty invocation never satisfies an evidence need', () => {
  assert.deepEqual(
    evaluateSatisfaction(base, { nonempty: false, references: [], fresh: true }),
    { satisfied: false, failure: 'empty' },
  );
});

test('irrelevant nonempty result never satisfies an evidence need', () => {
  assert.deepEqual(
    evaluateSatisfaction(base, { nonempty: true, references: ['logout'], fresh: true }),
    { satisfied: false, failure: 'irrelevant' },
  );
});

test('an unresolved relevance target fails closed', () => {
  assert.deepEqual(
    evaluateSatisfaction({ ...base, requires_relevance_to: [] }, {
      nonempty: true,
      references: ['anything'],
      fresh: true,
    }),
    { satisfied: false, failure: 'irrelevant' },
  );
});

test('freshness is enforced only when the contract requires it', () => {
  assert.deepEqual(
    evaluateSatisfaction({ ...base, freshness: 'fresh' }, {
      nonempty: true,
      references: ['performSync'],
      fresh: false,
    }),
    { satisfied: false, failure: 'stale' },
  );
});

test('relevant evidence satisfies the obligation', () => {
  assert.deepEqual(
    evaluateSatisfaction(base, {
      nonempty: true,
      references: ['runSyncJob', 'performSync'],
      fresh: true,
    }),
    { satisfied: true, failure: 'none' },
  );
});
