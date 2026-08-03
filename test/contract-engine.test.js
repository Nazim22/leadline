'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  DECISIONS, createContractEngine, loadPolicyPacks, renderDecisionTrace,
} = require('../src/contract-engine');
const { createPlanner } = require('../src/planner');

const root = path.join(__dirname, '..');
const planner = createPlanner({
  tellsPath: path.join(root, 'policy', 'tells.yaml'),
  routesPath: path.join(root, 'policy', 'routes.yaml'),
});
const packs = loadPolicyPacks({
  directory: path.join(root, 'policy', 'packs'),
  schemaPath: path.join(root, 'schema', 'policy-pack.schema.json'),
});

function engine(mode = 'enforce') {
  return createContractEngine({ planner, packs, mode });
}

function stateFor(prompt, mode = 'enforce') {
  return engine(mode).begin(prompt, { sessionId: 'session-1', turnId: 'turn-1' }).state;
}

test('contract engine has no network or process execution path', () => {
  const source = require('node:fs').readFileSync(path.join(root, 'src', 'contract-engine.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:http|https|net|dns|dgram|tls|undici|child_process)['"]\)/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
});

test('contract engine exposes the closed emission API and begins from the existing planner', () => {
  assert.deepEqual(DECISIONS, ['ALLOW', 'DENY', 'ASK', 'CORRECT', 'ABSTAIN']);
  const begun = engine().begin('Who calls performSync?', { sessionId: 'session-1', turnId: 'turn-1' });
  assert.deepEqual(begun.state.contract.steps.map((step) => step.need), ['structural']);
  assert.equal(begun.state.contract.question, 'Who calls performSync?');
  assert.equal(begun.state.satisfied_step_ids.length, 0);
});

test('wrong-source structural reflex is denied with deterministic three-part grammar and trace', () => {
  const core = engine();
  const state = stateFor('Who calls performSync?');
  const decision = core.beforeTool(state, {
    provider: 'Grep', name: 'Grep', args: { pattern: 'performSync' },
  });

  assert.equal(decision.verdict, 'DENY');
  assert.equal(decision.message.split('\n').length, 3);
  assert.match(decision.message, /Structural evidence.*performSync.*Why:/);
  assert.match(decision.message, /mcp__gbrain__code_callers/);
  assert.match(decision.message, /fallback|abstain/i);
  assert.deepEqual(Object.keys(decision.trace), [
    'obligation', 'family', 'attempted', 'verdict', 'corrected_route', 'receipt',
  ]);
  assert.equal(decision.trace.attempted, 'Grep');
});

test('structural policy chooses the exact corrective operation for each obligation', () => {
  const cases = [
    ['Who calls performSync?', 'mcp__gbrain__code_callers'],
    ['Where is performSync defined?', 'mcp__gbrain__code_def'],
    ['Find references to performSync', 'mcp__gbrain__code_refs'],
    ['What are the callees of performSync?', 'mcp__gbrain__code_callees'],
    ['What is the blast radius of performSync?', 'mcp__gbrain__code_blast'],
  ];
  for (const [prompt, expected] of cases) {
    const state = stateFor(prompt);
    const decision = engine().beforeTool(state, {
      provider: 'Grep', name: 'Grep', args: { pattern: 'performSync' },
    });
    assert.equal(decision.trace.corrected_route, expected, prompt);
    assert.match(decision.message, new RegExp(expected), prompt);
    const operation = expected.split('__').at(-1);
    const preferred = { provider: expected, name: operation, args: { symbol: 'performSync' } };
    assert.equal(engine().beforeTool(state, preferred).verdict, 'ALLOW', prompt);
    assert.equal(engine().afterTool(state, preferred, { value: `${operation}: ${prompt}`, is_error: false }).verdict, 'ALLOW', prompt);
  }
});

test('advisory mode corrects but never denies the same wrong route', () => {
  const core = engine('advisory');
  const decision = core.beforeTool(stateFor('Who calls performSync?', 'advisory'), {
    provider: 'Grep', name: 'Grep', args: { pattern: 'performSync' },
  });
  assert.equal(decision.verdict, 'CORRECT');
  assert.equal(decision.block, false);
});

test('authoritative history pack corrects reconstruction and accepts a real recall receipt', () => {
  const core = engine();
  const state = stateFor('What did we decide about deployment?');
  const wrong = core.beforeTool(state, { provider: 'Read', name: 'Read', args: { file_path: 'README.md' } });
  assert.equal(wrong.verdict, 'DENY');
  assert.equal(wrong.trace.corrected_route, 'mcp__gbrain__query');
  const recall = { provider: 'mcp__gbrain__query', name: 'query', args: { query: 'deployment decision' } };
  assert.equal(core.beforeTool(state, recall).verdict, 'ALLOW');
  assert.equal(core.afterTool(state, recall, { value: 'The deployment decision is recorded in ADR-045.', is_error: false }).verdict, 'ALLOW');
});

test('preferred structural tool is allowed and a real relevant result satisfies the obligation', () => {
  const core = engine();
  const state = stateFor('Who calls performSync?');
  const toolCall = {
    provider: 'mcp__gbrain__code_callers', name: 'code_callers', args: { symbol: 'performSync' },
  };
  assert.equal(core.beforeTool(state, toolCall).verdict, 'ALLOW');
  const result = core.afterTool(state, toolCall, { value: { callers: ['runSync -> performSync'] }, is_error: false });
  assert.equal(result.verdict, 'ALLOW');
  assert.deepEqual(state.satisfied_step_ids, ['route-1']);
});

test('future timestamps cannot satisfy TTL freshness', () => {
  const fixedNow = new Date('2026-07-25T03:00:00.000Z');
  const core = createContractEngine({ planner, packs, mode: 'enforce', now: () => fixedNow });
  const protectedState = core.begin('Deploy the service', { sessionId: 'ttl', turnId: 'protected' }).state;
  const protectedRule = packs.flatMap((pack) => pack.rules).find((rule) => rule.trigger.tool_names?.includes('Bash'));
  protectedState.satisfied_rules[protectedRule.id] = fixedNow.valueOf() + 60000;
  assert.equal(core.beforeTool(protectedState, {
    provider: 'Bash', name: 'Bash', args: { command: 'terraform apply' },
  }).verdict, 'DENY');
});

test('wrapper metadata cannot make an empty query result substantive', () => {
  const state = stateFor('Who calls performSync?');
  const tool = { provider: 'mcp__gbrain__code_callers', name: 'code_callers', args: { symbol: 'performSync' } };
  const decision = engine().afterTool(state, tool, {
    value: { query: 'performSync', results: [], is_error: false, status: 200 }, is_error: false,
  });
  assert.equal(decision.verdict, 'CORRECT');
  assert.equal(decision.trace.receipt.failure, 'empty');
  assert.deepEqual(state.satisfied_step_ids, []);
});

test('generic no-result text cannot satisfy real-result-only obligations', () => {
  const tool = { provider: 'mcp__gbrain__query', name: 'query', args: { query: 'deployment' } };
  for (const value of [
    'No results found for deployment.',
    'No callers found for performSync.',
    'Search completed: no results found for performSync.',
  ]) {
    const state = stateFor('What did we decide about deployment?');
    const decision = engine().afterTool(state, tool, { value, is_error: false });
    assert.equal(decision.verdict, 'CORRECT', value);
    assert.equal(decision.trace.receipt.failure, 'empty');
    assert.deepEqual(state.satisfied_step_ids, []);
  }
});

test('query echoes with empty collections cannot game real-result satisfaction', () => {
  const toolCall = {
    provider: 'mcp__gbrain__code_callers', name: 'code_callers', args: { symbol: 'performSync' },
  };
  const echoState = stateFor('Who calls performSync?');
  const echo = engine().afterTool(echoState, toolCall, {
    value: { symbol: 'performSync', callers: [] }, is_error: false,
  });
  assert.equal(echo.verdict, 'CORRECT');
  assert.equal(echo.trace.receipt.satisfied, false);
  assert.deepEqual(echoState.satisfied_step_ids, []);

  const negativeState = stateFor('Who calls performSync?');
  const negative = engine().afterTool(negativeState, toolCall, {
    value: { symbol: 'performSync', count: 0, callers: [] }, is_error: false,
  });
  assert.equal(negative.verdict, 'ALLOW');
  assert.deepEqual(negativeState.satisfied_step_ids, ['route-1']);
});

test('post-tool feedback is corrective only for empty or irrelevant receipts and silent on success', () => {
  const core = engine();
  const emptyState = stateFor('Who calls performSync?');
  const toolCall = {
    provider: 'mcp__gbrain__code_callers', name: 'code_callers', args: { symbol: 'performSync' },
  };
  const empty = core.afterTool(emptyState, toolCall, { value: '', is_error: false });
  assert.equal(empty.verdict, 'CORRECT');
  assert.equal(empty.message.split('\n').length, 1);
  assert.match(empty.message, /real non-empty result/i);

  const goodState = stateFor('Who calls performSync?');
  const good = core.afterTool(goodState, toolCall, { value: 'performSync called by runSync', is_error: false });
  assert.equal(good.verdict, 'ALLOW');
  assert.equal(good.message, '');
});

test('protected operation creates a prerequisite and accepts only a real corrective result', () => {
  const core = engine();
  const state = stateFor('Deploy the service');
  const deploy = { provider: 'Bash', name: 'Bash', args: { command: 'terraform apply' } };
  const denied = core.beforeTool(state, deploy);
  assert.equal(denied.verdict, 'DENY');
  assert.match(denied.message, /Read \.leadline\/access-map\.md/);

  const fakeRead = { provider: 'Read', name: 'Read', args: { file_path: '.leadline/access-map.md.evil' } };
  assert.equal(core.afterTool(state, fakeRead, { value: 'fabricated', is_error: false }).verdict, 'ALLOW');
  const slashImpostor = { provider: 'Read', name: 'Read', args: { file_path: '.leadline\\access-map.md' } };
  assert.equal(core.afterTool(state, slashImpostor, { value: 'fabricated', is_error: false }).verdict, 'ALLOW');
  const normalizedAlias = { provider: 'Read', name: 'Read', args: { file_path: '.leadline/symlink/../access-map.md' } };
  assert.equal(core.afterTool(state, normalizedAlias, { value: 'fabricated', is_error: false }).verdict, 'ALLOW');
  assert.equal(state.satisfied_rules[Object.keys(state.rule_denials)[0]], undefined);
  const afterFake = core.beforeTool(state, deploy);
  assert.equal(afterFake.verdict, 'ASK');
  assert.notEqual(afterFake.verdict, 'ALLOW');

  const read = { provider: 'Read', name: 'Read', args: { file_path: '.leadline/access-map.md' } };
  assert.equal(core.afterTool(state, read, { value: 'production requires approval', is_error: false }).verdict, 'ALLOW');
  assert.equal(core.beforeTool(state, deploy).verdict, 'ALLOW');
});

test('configured Read paths preserve exact case while matching the Read operation case-insensitively', () => {
  const customPacks = structuredClone(packs);
  const rule = customPacks.find((pack) => pack.id === 'prerequisite-before-protected-ops').rules[0];
  rule.preferred_route = 'Read README.md';
  const core = createContractEngine({ planner, packs: customPacks, mode: 'enforce' });
  const state = core.begin('Deploy service', { sessionId: 'case-session', turnId: 'case-turn' }).state;
  const deploy = { provider: 'Bash', name: 'Bash', args: { command: 'terraform apply' } };
  assert.equal(core.beforeTool(state, deploy).verdict, 'DENY');

  const wrongCase = { provider: 'Read', name: 'Read', args: { file_path: 'readme.md' } };
  assert.equal(core.afterTool(state, wrongCase, { value: 'wrong file', is_error: false }).verdict, 'ALLOW');
  assert.equal(state.satisfied_rules[rule.id], undefined);

  const exactCase = { provider: 'read', name: 'Read', args: { file_path: 'README.md' } };
  assert.equal(core.afterTool(state, exactCase, { value: 'right file', is_error: false }).verdict, 'ALLOW');
  assert.ok(Number.isFinite(state.satisfied_rules[rule.id]));
});

test('human approval binds to the exact protected operation', () => {
  const core = engine();
  const state = stateFor('Deploy the service');
  const terraform = { provider: 'Bash', name: 'Bash', args: { command: 'terraform apply' }, call_id: 'terraform-1' };
  const kubectl = { provider: 'Bash', name: 'Bash', args: { command: 'kubectl delete deployment app' }, call_id: 'kubectl-1' };
  assert.equal(core.beforeTool(state, terraform).verdict, 'DENY');
  assert.equal(core.beforeTool(state, terraform).verdict, 'ASK');
  assert.notEqual(core.afterTool(state, kubectl, { value: 'deleted', is_error: false }).trace?.receipt?.human_approval_followed, true);
  assert.equal(core.afterTool(state, terraform, { value: 'applied', is_error: false }).trace.receipt.human_approval_followed, true);
  assert.equal(core.beforeTool(state, kubectl).verdict, 'DENY');
});

test('a missing correction target abstains immediately and retires the rule', () => {
  const core = createContractEngine({
    planner, packs, mode: 'enforce', routeAvailable: (route) => route !== 'Read .leadline/access-map.md',
  });
  const state = core.begin('Deploy the service', { sessionId: 'missing', turnId: 'target' }).state;
  const deploy = { provider: 'Bash', name: 'Bash', args: { command: 'terraform apply' } };
  const first = core.beforeTool(state, deploy);
  assert.equal(first.verdict, 'ABSTAIN');
  assert.equal(first.block, false);
  assert.equal(first.trace.attempted, 'Bash');
  assert.equal(first.trace.receipt.failure, 'unsatisfiable');
  assert.equal(first.trace.receipt.fire_count, 0);
  assert.match(first.trace.receipt.rule_id, /access-map/);
  assert.equal(core.beforeTool(state, deploy).verdict, 'ALLOW');
  assert.equal(core.beforeTool(state, deploy).trace, null);
});

test('the third correction abstains once, retires the step, and allows the call', () => {
  const core = engine();
  const state = stateFor('Who calls performSync?');
  const wrong = { provider: 'Grep', name: 'Grep', args: { pattern: 'performSync' } };
  assert.equal(core.beforeTool(state, wrong).verdict, 'DENY');
  assert.equal(core.beforeTool(state, wrong).verdict, 'DENY');
  const third = core.beforeTool(state, wrong);
  assert.equal(third.verdict, 'ABSTAIN');
  assert.equal(third.block, false);
  assert.equal(third.trace.attempted, 'Grep');
  assert.equal(third.trace.receipt.failure, 'unsatisfiable');
  assert.equal(third.trace.receipt.fire_count, 3);
  assert.ok(typeof third.trace.receipt.rule_id === 'string' && third.trace.receipt.rule_id.length > 0);
  assert.equal(core.beforeTool(state, wrong).verdict, 'ALLOW');
  assert.equal(core.beforeTool(state, wrong).trace, null);
});

test('an obligation older than fifteen minutes abstains on its next corrective fire', () => {
  let clock = new Date('2026-08-03T20:00:00.000Z');
  const core = createContractEngine({ planner, packs, mode: 'enforce', now: () => clock });
  const state = core.begin('Who calls performSync?', { sessionId: 'expiry', turnId: 'time' }).state;
  clock = new Date('2026-08-03T20:15:00.000Z');
  const decision = core.beforeTool(state, { provider: 'Grep', name: 'Grep', args: { pattern: 'performSync' } });
  assert.equal(decision.verdict, 'ABSTAIN');
  assert.equal(decision.block, false);
  assert.equal(decision.trace.receipt.failure, 'unsatisfiable');
  assert.equal(decision.trace.receipt.fire_count, 1);
});

test('protected-operation escalation also retires on the third fire in enforce mode', () => {
  const core = createContractEngine({ planner, packs, mode: 'enforce', routeAvailable: () => true });
  const state = core.begin('Deploy the service', { sessionId: 'protected', turnId: 'expiry' }).state;
  const deploy = { provider: 'Bash', name: 'Bash', args: { command: 'terraform apply' } };
  assert.equal(core.beforeTool(state, deploy).verdict, 'DENY');
  assert.equal(core.beforeTool(state, deploy).verdict, 'ASK');
  const third = core.beforeTool(state, deploy);
  assert.equal(third.verdict, 'ABSTAIN');
  assert.equal(third.block, false);
  assert.equal(third.trace.receipt.fire_count, 3);
  assert.equal(core.beforeTool(state, deploy).verdict, 'ALLOW');
});

test('all emitted trace rows have a non-empty attempted and receipt rule id', () => {
  const core = engine();
  const state = stateFor('Who calls performSync?');
  const rows = [
    core.beforeTool(state, { provider: 'Grep', name: 'Grep', args: { pattern: 'performSync' } }).trace,
    core.beforeStop(state, 'Done.').trace,
  ];
  for (const row of rows) {
    assert.ok(typeof row.attempted === 'string' && row.attempted.length > 0);
    assert.ok(typeof row.receipt.rule_id === 'string' && row.receipt.rule_id.length > 0);
  }
});

test('stop blocks twice then warns and allows to prevent a session lockup', () => {
  const core = engine();
  const state = stateFor('Who calls performSync?');
  const first = core.beforeStop(state, 'I am done.');
  const second = core.beforeStop(state, 'Still done.');
  const third = core.beforeStop(state, 'Done now.');
  assert.equal(first.verdict, 'DENY');
  assert.equal(second.verdict, 'DENY');
  assert.equal(third.verdict, 'CORRECT');
  assert.equal(third.block, false);
  assert.equal(third.trace.receipt.anti_lockup_downgrade, true);
});

test('explicit abstention with a reason is a legal stop outcome', () => {
  const core = engine();
  const state = stateFor('Who calls performSync?');
  const decision = core.beforeStop(state, 'I explicitly abstain because the code graph is unavailable.');
  assert.equal(decision.verdict, 'ABSTAIN');
  assert.equal(decision.block, false);
});

test('pretty trace renderer reports the session story and counts', () => {
  const rows = [
    { obligation: 'callers of x', family: 'structural', attempted: 'Grep', verdict: 'DENY', corrected_route: 'code_callers', receipt: { rule_id: 'code-intel' } },
    { obligation: 'callers of x', family: 'structural', attempted: 'code_callers', verdict: 'ALLOW', corrected_route: null, receipt: { satisfied: true, correction_followed: true } },
    { obligation: 'runtime of y', family: 'runtime', attempted: null, verdict: 'ABSTAIN', corrected_route: 'cli-probe', receipt: { reason: 'unavailable' } },
  ];
  const output = renderDecisionTrace(rows);
  assert.match(output, /denials: 1/);
  assert.match(output, /corrections followed: 1/);
  assert.match(output, /abstentions: 1/);
  assert.match(output, /Grep.*DENY.*code_callers/);
});
