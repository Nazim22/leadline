'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLAUDE_CODE_CAPABILITIES, _withStateLock, handleClaudeHook, installClaudeCode,
} = require('../src/claude-code');
const { main } = require('../bin/leadline');

const root = path.join(__dirname, '..');

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-claude-project-'));
}

function event(projectDir, hookEventName, extra = {}) {
  return {
    session_id: 'session-live-1', cwd: projectDir, hook_event_name: hookEventName,
    transcript_path: path.join(projectDir, 'transcript.jsonl'), permission_mode: 'default', ...extra,
  };
}

test('Claude Code declares full enforcement capabilities', () => {
  assert.deepEqual(CLAUDE_CODE_CAPABILITIES, {
    schema_version: '1.0', mode: 'ENFORCE', inject_before_action: true, intercept_tool_call: true,
    deny_tool_call: true, request_human_approval: true, inspect_tool_result: true,
    block_completion: true,
  });
});

test('installer merges all four hooks into a real project without deleting existing settings', () => {
  const target = project();
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
  const result = installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert.equal(settings.hooks[name].length, 1);
    assert.match(settings.hooks[name][0].hooks[0].command, /leadline\.js.* hook/);
    assert.match(settings.hooks[name][0].hooks[0].command, new RegExp(name));
  }
  assert.equal(fs.existsSync(path.join(target, '.leadline', 'packs', 'code-intelligence-before-raw-search.yaml')), true);
  assert.equal(result.mode, 'enforce');
});

test('installer replaces only managed hook entries inside a mixed group', () => {
  const target = project();
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  const unrelated = { type: 'command', command: '/usr/bin/other-hook' };
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: '/old/bin/leadline.js hook PreToolUse --project x' }, unrelated,
    ] }] },
  }));
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  const groups = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { matcher: 'Bash', hooks: [unrelated] });
  assert.match(groups[1].hooks[0].command, /leadline\.js.* hook PreToolUse/);
});

test('installer is idempotent and dry-run installs advisory mode', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'advisory' });
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'advisory' });
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) assert.equal(settings.hooks[name].length, 1);
  assert.match(fs.readFileSync(path.join(target, '.leadline', 'config.yaml'), 'utf8'), /mode: advisory/);
});

test('advisory PostToolUse feedback never blocks the Claude loop', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'advisory' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  handleClaudeHook(event(target, 'PreToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' }, tool_use_id: 'tool-empty',
  }), { projectDir: target, packageRoot: root });
  const feedback = handleClaudeHook(event(target, 'PostToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' },
    tool_response: {}, tool_use_id: 'tool-empty',
  }), { projectDir: target, packageRoot: root });
  assert.equal(feedback.decision, undefined);
  assert.equal(feedback.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(feedback.hookSpecificOutput.additionalContext, /Receipt failed/);
});

test('advisory Stop surfaces an unmet obligation without blocking', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'advisory' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });

  const stopped = handleClaudeHook(event(target, 'Stop', {
    stop_hook_active: false, last_assistant_message: 'Done.',
  }), { projectDir: target, packageRoot: root });

  assert.equal(stopped.decision, undefined);
  assert.equal(stopped.hookSpecificOutput, undefined);
  assert.match(stopped.systemMessage, /Unmet obligation/);
});

test('advisory Stop stays quiet when every obligation is satisfied', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'advisory' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  const graphInput = event(target, 'PreToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' }, tool_use_id: 'tool-right',
  });
  handleClaudeHook(graphInput, { projectDir: target, packageRoot: root });
  handleClaudeHook(event(target, 'PostToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' },
    tool_response: { callers: ['runSync calls performSync'] }, tool_use_id: 'tool-right',
  }), { projectDir: target, packageRoot: root });

  assert.deepEqual(handleClaudeHook(event(target, 'Stop', {
    stop_hook_active: false, last_assistant_message: 'Verified callers.',
  }), { projectDir: target, packageRoot: root }), {});
});

test('UserPromptSubmit injects a compact route block and stays silent without obligations', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  const routed = handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  const context = routed.hookSpecificOutput.additionalContext;
  assert.equal(routed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(context.split('\n').length <= 10);
  assert.match(context, /complete: true/);
  assert.match(context, /family: structural/);
  assert.deepEqual(handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Make it better' }), { projectDir: target, packageRoot: root }), {});
});

test('protected operation denial escalates to an executable human approval fallback', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Deploy the service' }), { projectDir: target, packageRoot: root });
  const pre = event(target, 'PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'terraform apply' }, tool_use_id: 'deploy-1',
  });
  assert.equal(handleClaudeHook(pre, { projectDir: target, packageRoot: root }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(handleClaudeHook(pre, { projectDir: target, packageRoot: root }).hookSpecificOutput.permissionDecision, 'ask');
  assert.deepEqual(handleClaudeHook(event(target, 'PostToolUse', {
    tool_name: 'Bash', tool_input: { command: 'terraform apply' }, tool_response: 'applied', tool_use_id: 'deploy-1',
  }), { projectDir: target, packageRoot: root }), {});
  assert.deepEqual(handleClaudeHook(event(target, 'Stop', {
    stop_hook_active: false, last_assistant_message: 'Deployment completed after approval.',
  }), { projectDir: target, packageRoot: root }), {});
});

test('PreToolUse deny, PostToolUse receipt, and Stop success fire through persisted session state', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });

  const denied = handleClaudeHook(event(target, 'PreToolUse', {
    tool_name: 'Grep', tool_input: { pattern: 'performSync' }, tool_use_id: 'tool-wrong',
  }), { projectDir: target, packageRoot: root });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.hookSpecificOutput.permissionDecisionReason.split('\n').length, 3);

  const graphInput = event(target, 'PreToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' }, tool_use_id: 'tool-right',
  });
  assert.deepEqual(handleClaudeHook(graphInput, { projectDir: target, packageRoot: root }), {});
  const post = handleClaudeHook(event(target, 'PostToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' },
    tool_response: { callers: ['runSync calls performSync'] }, tool_use_id: 'tool-right',
  }), { projectDir: target, packageRoot: root });
  assert.deepEqual(post, {});
  assert.deepEqual(handleClaudeHook(event(target, 'Stop', {
    stop_hook_active: false, last_assistant_message: 'Verified callers.',
  }), { projectDir: target, packageRoot: root }), {});

  const trace = fs.readFileSync(path.join(target, '.leadline', 'traces', 'session-live-1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(trace.length >= 3);
  assert.ok(trace.every((row) => JSON.stringify(Object.keys(row)) === JSON.stringify([
    'obligation', 'family', 'attempted', 'verdict', 'corrected_route', 'receipt',
  ])));
});

test('PostToolUse receipts must match and consume an accepted PreToolUse call', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  const post = (toolUseId, toolInput) => handleClaudeHook(event(target, 'PostToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: toolInput,
    tool_response: { callers: ['runSync calls performSync'] }, tool_use_id: toolUseId,
  }), { projectDir: target, packageRoot: root });

  assert.equal(post('late-call', { symbol: 'performSync' }).decision, 'block');
  handleClaudeHook(event(target, 'PreToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' }, tool_use_id: 'bound-call',
  }), { projectDir: target, packageRoot: root });
  assert.equal(post('bound-call', { symbol: 'differentSymbol' }).decision, 'block');
  assert.deepEqual(post('bound-call', { symbol: 'performSync' }), {});
  assert.equal(post('bound-call', { symbol: 'performSync' }).decision, 'block');
});

test('unbound PostToolUse is advisory-only in advisory mode', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'advisory' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  const feedback = handleClaudeHook(event(target, 'PostToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' },
    tool_response: { callers: ['runSync calls performSync'] }, tool_use_id: 'late-call',
  }), { projectDir: target, packageRoot: root });
  assert.equal(feedback.decision, undefined);
  assert.match(feedback.hookSpecificOutput.additionalContext, /unbound/i);
});

test('PostToolUse emits one-line failure feedback and Stop anti-lockup warns then allows', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  handleClaudeHook(event(target, 'PreToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' }, tool_use_id: 'tool-empty',
  }), { projectDir: target, packageRoot: root });
  const failed = handleClaudeHook(event(target, 'PostToolUse', {
    tool_name: 'mcp__gbrain__code_callers', tool_input: { symbol: 'performSync' },
    tool_response: {}, tool_use_id: 'tool-empty',
  }), { projectDir: target, packageRoot: root });
  assert.equal(failed.decision, 'block');
  assert.equal(failed.reason.split('\n').length, 1);

  const stop = () => handleClaudeHook(event(target, 'Stop', {
    stop_hook_active: true, last_assistant_message: 'Done.',
  }), { projectDir: target, packageRoot: root });
  assert.equal(stop().decision, 'block');
  assert.equal(stop().decision, 'block');
  const allowed = stop();
  assert.equal(allowed.decision, undefined);
  assert.equal(allowed.hookSpecificOutput, undefined);
  assert.match(allowed.systemMessage, /warn/i);
});

function runHookCommand(command, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(`hook exited ${status}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('parallel Stop hook processes preserve the session denial count', async () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.Stop[0].hooks[0].command;
  const input = event(target, 'Stop', { stop_hook_active: true, last_assistant_message: 'Done.' });
  const outputs = await Promise.all([
    runHookCommand(command, input, target),
    runHookCommand(command, input, target),
    runHookCommand(command, input, target),
  ]);
  assert.equal(outputs.filter((output) => output.decision === 'block').length, 2);
  assert.equal(outputs.filter((output) => /warn/i.test(output.systemMessage || '')).length, 1);
});

test('an expired original owner cannot delete a fresh replacement lock on release', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  const sessionId = 'aba-owner';
  const lock = path.join(target, '.leadline', 'state', `${sessionId}.json.lock`);
  const command = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'))
    .hooks.Stop[0].hooks[0].command;

  _withStateLock(target, sessionId, () => {
    const stale = new Date(Date.now() - 60000);
    fs.utimesSync(lock, stale, stale);
    const reclaimed = spawnSync(command, {
      cwd: target, shell: true, encoding: 'utf8',
      input: JSON.stringify(event(target, 'Stop', {
        session_id: sessionId, stop_hook_active: true, last_assistant_message: 'Done.',
      })),
      env: { ...process.env, CLAUDE_PROJECT_DIR: target },
    });
    assert.equal(reclaimed.status, 0, reclaimed.stderr);
    assert.equal(fs.existsSync(lock), false);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), 'fresh-replacement');
  });

  assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), 'fresh-replacement');
  fs.rmSync(lock, { recursive: true, force: true });
});

test('concurrent stale-lock recovery never deletes a fresh owner lock', async () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  const lock = path.join(target, '.leadline', 'state', 'session-live-1.json.lock');
  fs.mkdirSync(lock);
  const stale = new Date(Date.now() - 60000);
  fs.utimesSync(lock, stale, stale);
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.Stop[0].hooks[0].command;
  const input = event(target, 'Stop', { stop_hook_active: true, last_assistant_message: 'Done.' });
  const outputs = await Promise.all(Array.from({ length: 12 }, () => runHookCommand(command, input, target)));
  assert.equal(outputs.filter((output) => output.decision === 'block').length, 2);
  assert.equal(outputs.filter((output) => /warn/i.test(output.systemMessage || '')).length, 10);
});

test('hook process errors use Claude blocking exit code 2', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'enforce' });
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  fs.writeFileSync(path.join(target, '.leadline', 'state', 'session-live-1.json'), '{');
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const fired = spawnSync(command, {
    cwd: target, shell: true, encoding: 'utf8',
    input: JSON.stringify(event(target, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'terraform apply' } })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
  });
  assert.equal(fired.status, 2, fired.stderr);
  assert.match(fired.stderr, /leadline:/);
});

test('advisory hook process errors log but remain non-blocking', () => {
  const target = project();
  installClaudeCode({ projectDir: target, packageRoot: root, mode: 'advisory' });
  const configPath = path.join(target, '.leadline', 'config.yaml');
  fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('mode: advisory', 'mode: "advisory"'));
  handleClaudeHook(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' }), { projectDir: target, packageRoot: root });
  fs.writeFileSync(path.join(target, '.leadline', 'state', 'session-live-1.json'), '{');
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const fired = spawnSync(command, {
    cwd: target, shell: true, encoding: 'utf8',
    input: JSON.stringify(event(target, 'PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'performSync' } })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
  });
  assert.equal(fired.status, 0, fired.stderr);
  assert.deepEqual(JSON.parse(fired.stdout), {});
  assert.match(fired.stderr, /leadline:/);
});

test('CLI main accepts documented init, hook, route, and trace argv contracts', () => {
  const target = project();
  const output = [];
  const errors = [];
  const io = { cwd: target, stdout: { write: (s) => output.push(s) }, stderr: { write: (s) => errors.push(s) } };
  assert.equal(main(['init', '--claude-code', '--project', target, '--dry-run'], io), 0);
  assert.equal(main(['route', 'Who', 'calls', 'performSync?'], io), 0);
  assert.equal(main(['trace', '--project', target, '--session', 'missing'], io), 0);
  assert.deepEqual(errors, []);
});

test('real CLI process installs and a generated Claude hook command fires', () => {
  const target = project();
  const cli = path.join(root, 'bin', 'leadline.js');
  const init = spawnSync(process.execPath, [cli, 'init', '--claude-code', '--project', target], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  const fired = spawnSync(command, {
    cwd: target, shell: true, encoding: 'utf8',
    input: JSON.stringify(event(target, 'UserPromptSubmit', { prompt: 'Who calls performSync?' })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
  });
  assert.equal(fired.status, 0, fired.stderr);
  const response = JSON.parse(fired.stdout);
  assert.match(response.hookSpecificOutput.additionalContext, /family: structural/);
});
