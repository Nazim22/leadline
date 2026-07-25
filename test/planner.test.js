'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPlanner } = require('../src/planner');

const root = path.join(__dirname, '..');
const planner = createPlanner({
  tellsPath: path.join(root, 'policy', 'tells.yaml'),
  routesPath: path.join(root, 'policy', 'routes.yaml'),
});

test('emits a schema-shaped ordered multi-step route contract', () => {
  const contract = planner.plan('Did we ship promotions, and where is applyPromo defined?', {
    turnId: 'turn-1',
  });

  assert.equal(contract.schema_version, '1.0');
  assert.equal(contract.turn_id, 'turn-1');
  assert.deepEqual(contract.steps.map((step) => step.need), ['historical', 'structural']);
  assert.deepEqual(contract.ordered_route, ['route-1', 'route-2']);
  assert.equal(contract.first_action, 'gbrain');
  assert.equal(contract.abstained, false);
  assert.equal(contract.abstain_reason, null);
  assert.equal(contract.complete, true);
  assert.deepEqual(contract.unmatched_clauses, []);
  assert.deepEqual(contract.steps[1].satisfaction.requires_relevance_to, ['applyPromo']);
  assert.match(contract.steps[1].classified_by, /^tell:/);
});

test('deduplicates repeated tells from the same family into one obligation', () => {
  const contract = planner.plan('Show the exact file at commit a0ef989', { turnId: 'turn-2' });

  assert.deepEqual(contract.steps.map((step) => step.need), ['repository']);
  assert.equal(contract.steps[0].classified_by, 'tell:repo-bytes');
});

test('abstains honestly when no high-precision tell matches', () => {
  const contract = planner.plan('Make it better', { turnId: 'turn-3' });

  assert.deepEqual(contract.steps, []);
  assert.deepEqual(contract.ordered_route, []);
  assert.equal(contract.first_action, null);
  assert.equal(contract.abstained, true);
  assert.equal(contract.abstain_reason, 'no_high_precision_tell');
});

test('emits relevance anchors and carries them across a pronoun-only follow-up', () => {
  const contract = planner.plan('Did we ship the graph fix, and is it live?', { turnId: 'turn-4' });

  assert.deepEqual(contract.steps[0].satisfaction.requires_relevance_to, ['graph', 'fix']);
  assert.deepEqual(contract.steps[1].satisfaction.requires_relevance_to, ['graph', 'fix']);
  assert.equal(contract.steps[1].evidence_target.subject, 'graph fix');
});

test('does not fabricate provider availability in measurement-only V0', () => {
  const contract = planner.plan('Who calls chargeCard?', { turnId: 'turn-5' });

  assert.equal(Object.hasOwn(contract.steps[0], 'availability'), false);
  assert.equal(Object.hasOwn(contract.steps[0], 'fallback'), false);
});

test('preserves repeated same-family obligations when subjects differ', () => {
  const contract = planner.plan(
    'Who calls alpha, then show the exact file config.js, then who calls beta?',
    { turnId: 'turn-6' },
  );

  assert.deepEqual(contract.steps.map((step) => step.need), ['structural', 'repository', 'structural']);
  assert.deepEqual(contract.steps.map((step) => step.evidence_target.subject), ['alpha', 'config.js', 'beta']);
  assert.deepEqual(contract.ordered_route, ['route-1', 'route-2', 'route-3']);
  assert.equal(contract.complete, true);
});

test('signals unmatched clauses instead of silently returning a partial success', () => {
  const contract = planner.plan('Who calls alpha, then explain how to migrate it', { turnId: 'turn-7' });

  assert.deepEqual(contract.steps.map((step) => step.need), ['structural']);
  assert.equal(contract.abstained, false);
  assert.equal(contract.complete, false);
  assert.deepEqual(contract.unmatched_clauses, [{
    index: 1,
    text: 'explain how to migrate it',
    start: 22,
    end: 47,
    reason: 'no_high_precision_tell',
  }]);
});

test('abstains when a matched route has no evidence relevance anchor', () => {
  const contract = planner.plan('is it live?', { turnId: 'turn-8' });

  assert.deepEqual(contract.steps, []);
  assert.equal(contract.abstained, true);
  assert.equal(contract.complete, false);
  assert.equal(contract.abstain_reason, 'unresolved_evidence_target');
  assert.equal(contract.unmatched_clauses[0].reason, 'unresolved_evidence_target');
});

test('does not let an exclusion hide unmatched positive work in the same clause', () => {
  const contract = planner.plan("don't check runtime and explain how to migrate it", { turnId: 'turn-9' });

  assert.deepEqual(contract.steps, []);
  assert.equal(contract.complete, false);
  assert.equal(contract.unmatched_clauses[0].reason, 'no_high_precision_tell');
});

test('routes positive runtime work outside a negated runtime span', () => {
  const contract = planner.plan("don't check whether it's deployed, just check port 443 open", { turnId: 'turn-10' });

  assert.deepEqual(contract.steps.map((step) => step.need), ['runtime']);
  assert.equal(contract.steps[0].evidence_target.subject, 'port 443');
  assert.deepEqual(contract.steps[0].satisfaction.requires_relevance_to, ['port 443']);
  assert.equal(contract.complete, true);
});
