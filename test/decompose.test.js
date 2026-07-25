'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decompose } = require('../src/decompose');

test('splits explicit sequencing cues while preserving source order', () => {
  assert.deepEqual(
    decompose('Find callers of settle() then show its exact body'),
    [
      { text: 'Find callers of settle()', start: 0, end: 24 },
      { text: 'show its exact body', start: 30, end: 49 },
    ],
  );
});

test('consumes a comma that belongs to a then separator', () => {
  assert.deepEqual(
    decompose('Who calls alpha, then show the exact file config.js'),
    [
      { text: 'Who calls alpha', start: 0, end: 15 },
      { text: 'show the exact file config.js', start: 22, end: 51 },
    ],
  );
});

test('splits comma conjunctions used for separate evidence obligations', () => {
  assert.deepEqual(
    decompose("Tell me what we decided about RLS, but don't check whether it's deployed"),
    [
      { text: 'Tell me what we decided about RLS', start: 0, end: 33 },
      { text: "don't check whether it's deployed", start: 39, end: 72 },
    ],
  );
});

test('prefers under-splitting for bare conjunctions inside one obligation', () => {
  assert.deepEqual(
    decompose('What calls and imports the config loader?'),
    [{ text: 'What calls and imports the config loader?', start: 0, end: 41 }],
  );
});

test('splits a bare conjunction only when the next side starts a new question', () => {
  assert.deepEqual(
    decompose('Did we ship the graph fix and is it live?'),
    [
      { text: 'Did we ship the graph fix', start: 0, end: 25 },
      { text: 'is it live?', start: 30, end: 41 },
    ],
  );
});
