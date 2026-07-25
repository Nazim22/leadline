'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadPolicy, matchPrompt } = require('../src/matcher');

const policyPath = path.join(__dirname, '..', 'policy', 'tells.yaml');

test('returns tell id, family, clause, and exact prompt span', () => {
  const policy = loadPolicy(policyPath);
  const matches = matchPrompt('Please show the callers of frameSign in the connector', policy);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'struct-callers');
  assert.equal(matches[0].family, 'structural');
  assert.equal(matches[0].text.toLowerCase(), 'callers of');
  assert.deepEqual(matches[0].span, { start: 16, end: 26 });
});

test('matches bounded wildcard phrases without consuming the rest of the prompt', () => {
  const policy = loadPolicy(policyPath);
  const matches = matchPrompt('Where is performSync defined in this project?', policy);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].family, 'structural');
  assert.equal(matches[0].text, 'Where is performSync defined');
});

test('suppresses only the negated clause family', () => {
  const policy = loadPolicy(policyPath);
  const matches = matchPrompt(
    "Tell me what we decided about RLS, but don't check whether it's currently deployed",
    policy,
  );

  assert.deepEqual(matches.map((match) => match.family), ['historical']);
});

test('does not let an unrelated negative object suppress a legitimate runtime tell', () => {
  const policy = loadPolicy(policyPath);
  const matches = matchPrompt("don't check callers, just see if it is live", policy);

  assert.deepEqual(matches.map((match) => match.family), ['runtime']);
});

test('suppresses only the negated runtime span when the same clause has positive runtime work', () => {
  const policy = loadPolicy(policyPath);
  const matches = matchPrompt("don't check whether it's deployed, just check port 443 open", policy);

  assert.deepEqual(matches.map((match) => [match.family, match.text]), [['runtime', 'port 443 open']]);
});

test('preserves first occurrence order across multiple evidence families', () => {
  const policy = loadPolicy(policyPath);
  const matches = matchPrompt(
    'Who calls settle(), then show the exact file at commit a0ef989',
    policy,
  );

  assert.deepEqual(matches.map((match) => match.family), ['structural', 'repository', 'repository']);
  assert.ok(matches[0].span.start < matches[1].span.start);
});

test('covers high-precision development variants without semantic inference', () => {
  const policy = loadPolicy(policyPath);

  assert.deepEqual(
    matchPrompt('is it live?', policy).map((match) => match.family),
    ['runtime'],
  );
  assert.deepEqual(
    matchPrompt('show me its exact implementation', policy).map((match) => match.family),
    ['repository'],
  );
  assert.deepEqual(
    matchPrompt('add a docstring to chargeCard', policy).map((match) => match.family),
    ['repository'],
  );
});

test('ignores tells inside quoted data, code, and shell procedure groups', () => {
  const policy = loadPolicy(policyPath);
  const prompts = [
    'Rewrite `who calls performSync` without running it',
    'Rewrite `literal `` who calls performSync` without running it',
    'The example says "who calls performSync"; rewrite it',
    'Rewrite "say \\"who calls performSync\\" now" without running it',
    'Rewrite "who calls performSync; then merge',
    'Example:\n```sh\nwho calls performSync\n```\nRewrite the example.',
    'Example:\n````md\n```\nwho calls performSync\n```\n````\nRewrite the example.',
    'byte-review (git fetch; git diff base..head), verify hashes, then merge',
  ];

  for (const prompt of prompts) assert.deepEqual(matchPrompt(prompt, policy), []);
});

test('removes naked executable mentions without suppressing evidence requests', () => {
  const policy = loadPolicy(policyPath);

  assert.deepEqual(matchPrompt('git diff base..head, then merge', policy), []);
  assert.deepEqual(
    matchPrompt('show diff for auth.js', policy).map((match) => match.family),
    ['repository'],
  );
  assert.deepEqual(
    matchPrompt('check whether port 443 is open', policy).map((match) => match.family),
    ['runtime'],
  );
});

test('retains an eligible evidence clause beside protected quoted data', () => {
  const policy = loadPolicy(policyPath);
  for (const prompt of [
    'Rewrite "who calls fake", and who calls performSync?',
    'Rewrite "say \\"who calls fake\\" now" and who calls performSync?',
  ]) {
    const matches = matchPrompt(prompt, policy);

    assert.deepEqual(matches.map((match) => [match.family, match.text]), [['structural', 'who calls']]);
    assert.deepEqual(matches[0].span, {
      start: prompt.lastIndexOf('who calls'),
      end: prompt.lastIndexOf('who calls') + 'who calls'.length,
    });
  }
});
