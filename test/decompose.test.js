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

test('bounds boundary whitespace at eight and safely under-splits longer runs', () => {
  const eight = 'Did we ship the graph fix        and        is it live?';
  assert.deepEqual(decompose(eight), [
    { text: 'Did we ship the graph fix', start: 0, end: 25 },
    { text: 'is it live?', start: 44, end: 55 },
  ]);

  const nine = 'Did we ship the graph fix         and         is it live?';
  assert.deepEqual(decompose(nine), [{ text: nine, start: 0, end: nine.length }]);
});

test('does not decompose delimiters inside protected shell groups or code spans', () => {
  const shell = 'byte-review (git fetch; git diff base..head), then merge';
  assert.deepEqual(decompose(shell), [
    { text: 'byte-review (git fetch; git diff base..head)', start: 0, end: shell.indexOf(', then') },
    { text: 'merge', start: shell.indexOf('merge'), end: shell.length },
  ]);

  for (const prompt of [
    'Rewrite `who calls alpha; then show beta` without executing it',
    'Rewrite `literal `` who calls alpha; then show beta` without executing it',
    'Rewrite "who calls alpha; then show beta" without executing it',
    'Rewrite "say \\"who calls alpha; then show beta\\" now" without executing it',
    'Rewrite "who calls alpha; then show beta',
    'Example:\n```sh\nwho calls alpha; then show beta\n```\nwithout executing it',
    'Example:\n````md\n```\nwho calls alpha; then show beta\n```\n````\nwithout executing it',
  ]) {
    assert.deepEqual(decompose(prompt), [{ text: prompt, start: 0, end: prompt.length }]);
  }
});
