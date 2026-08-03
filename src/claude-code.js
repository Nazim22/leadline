'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createPlanner } = require('./planner');
const {
  createContractEngine, loadPolicyPacks, negotiateAdapterMode, renderDecisionTrace, validateTraceRow,
} = require('./contract-engine');

const HOOK_EVENTS = Object.freeze(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
const CLAUDE_CODE_FEATURES = Object.freeze({
  inject_before_action: true,
  intercept_tool_call: true,
  deny_tool_call: true,
  request_human_approval: true,
  inspect_tool_result: true,
  block_completion: true,
});
const CLAUDE_CODE_CAPABILITIES = Object.freeze({
  schema_version: '1.0',
  mode: negotiateAdapterMode(CLAUDE_CODE_FEATURES),
  ...CLAUDE_CODE_FEATURES,
});

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function safeSessionId(sessionId) {
  const value = String(sessionId || 'unknown');
  return /^[A-Za-z0-9_.-]+$/u.test(value)
    ? value
    : `session-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function stateFile(projectDir, sessionId) {
  return path.join(projectDir, '.leadline', 'state', `${safeSessionId(sessionId)}.json`);
}

function traceFile(projectDir, sessionId) {
  return path.join(projectDir, '.leadline', 'traces', `${safeSessionId(sessionId)}.jsonl`);
}

function appendTrace(file, trace) {
  if (!trace) return;
  validateTraceRow(trace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(trace)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

function loadMode(projectDir) {
  const configFile = path.join(projectDir, '.leadline', 'config.yaml');
  if (!fs.existsSync(configFile)) return 'enforce';
  const config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  if (!config || !['enforce', 'advisory'].includes(config.mode)) throw new TypeError('Leadline config mode must be enforce or advisory');
  return config.mode;
}

function correctionRouteAvailable(projectDir, route) {
  const configured = String(route || '');
  if (!configured.toLocaleLowerCase().startsWith('read ')) return true;
  const target = configured.slice(5).trim();
  if (!target) return false;
  const absolute = path.resolve(projectDir, target);
  const relative = path.relative(projectDir, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  try {
    return fs.statSync(absolute).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function loadRuntime(projectDir, packageRoot) {
  const packDirectory = fs.existsSync(path.join(projectDir, '.leadline', 'packs'))
    ? path.join(projectDir, '.leadline', 'packs')
    : path.join(packageRoot, 'policy', 'packs');
  const planner = createPlanner({
    tellsPath: path.join(packageRoot, 'policy', 'tells.yaml'),
    routesPath: path.join(packageRoot, 'policy', 'routes.yaml'),
  });
  const packs = loadPolicyPacks({
    directory: packDirectory,
    schemaPath: path.join(packageRoot, 'schema', 'policy-pack.schema.json'),
  });
  return createContractEngine({
    planner, packs, mode: loadMode(projectDir),
    routeAvailable: (route) => correctionRouteAvailable(projectDir, route),
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toolBinding(input, state) {
  if (typeof input.tool_use_id !== 'string' || !input.tool_use_id) return null;
  const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  return {
    call_id: input.tool_use_id,
    turn_id: state.turn_id,
    tool_name: String(input.tool_name || 'unknown'),
    args_sha256: crypto.createHash('sha256').update(canonicalJson(args)).digest('hex'),
  };
}

function sameBinding(expected, actual) {
  return expected && actual
    && expected.turn_id === actual.turn_id
    && expected.tool_name === actual.tool_name
    && expected.args_sha256 === actual.args_sha256;
}

function toolCallFrom(input) {
  const provider = String(input.tool_name || 'unknown');
  const name = provider.toLocaleLowerCase().startsWith('mcp__') ? provider.split('__').at(-1) : provider;
  return {
    provider, name, args: input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {},
    call_id: typeof input.tool_use_id === 'string' ? input.tool_use_id : null,
  };
}

function emptyState(engine, input) {
  return engine.begin('', {
    sessionId: String(input.session_id || 'unknown'),
    turnId: `turn-${crypto.createHash('sha256').update(String(input.session_id || '')).digest('hex').slice(0, 16)}`,
  }).state;
}

function stripInjectedSpans(prompt) {
  return String(prompt || '')
    .replace(/<task-notification(?:\s[^>]*)?>[\s\S]*?(?:<\/task-notification>|$)/giu, '\n')
    .replace(/<system-reminder(?:\s[^>]*)?>[\s\S]*?(?:<\/system-reminder>|$)/giu, '\n')
    .replace(/\[LEADLINE\][\s\S]*?(?:\[\/LEADLINE\]|$)/giu, '\n');
}

function boundedField(value, maximumBytes) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (Buffer.byteLength(text, 'utf8') <= maximumBytes) return text;
  const words = text.split(' ');
  let bounded = '';
  for (const word of words) {
    const candidate = bounded ? `${bounded} ${word}` : word;
    if (Buffer.byteLength(`${candidate} …`, 'utf8') > maximumBytes) break;
    bounded = candidate;
  }
  return bounded ? `${bounded} …` : '[overlong token omitted]';
}

function renderInjection(contract) {
  if (!contract.steps.length) return '';
  const unmatched = contract.unmatched_clauses.length
    ? `${contract.unmatched_clauses.length} (${[...new Set(contract.unmatched_clauses.map((clause) => clause.reason))].join(', ')})`
    : 'none';
  const lines = [
    '[LEADLINE]',
    `contract: ${contract.contract_id}`,
    `complete: ${contract.complete}`,
    `unmatched: ${boundedField(unmatched, 160)}`,
  ];
  let omitted = Math.max(0, contract.steps.length - 4);
  for (const [index, step] of contract.steps.slice(0, 4).entries()) {
    const subject = boundedField(step.evidence_target.subject, 120);
    const route = boundedField(step.provider, 80);
    const line = `obligation_${index + 1}: ${subject} | family: ${step.need} | route: ${route} | satisfies: real_result_only`;
    if (Buffer.byteLength([...lines, line, '[/LEADLINE]'].join('\n'), 'utf8') <= 1200) lines.push(line);
    else omitted += 1;
  }
  if (omitted > 0) {
    const line = `obligations_omitted: ${omitted}`;
    if (Buffer.byteLength([...lines, line, '[/LEADLINE]'].join('\n'), 'utf8') <= 1200) lines.push(line);
  }
  lines.push('[/LEADLINE]');
  return lines.slice(0, 10).join('\n');
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withReapLock(lock, callback, wait = false) {
  const reap = `${lock}.reap`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(reap, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!wait) return false;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Leadline lock reaper: ${path.basename(lock)}`);
      sleep(10);
    }
  }
  try {
    callback();
    return true;
  } finally {
    fs.rmSync(reap, { recursive: true, force: true });
  }
}

function reclaimStaleLock(lock) {
  withReapLock(lock, () => {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
}

function withStateLock(projectDir, sessionId, callback) {
  const lock = `${stateFile(projectDir, sessionId)}.lock`;
  const owner = crypto.randomUUID();
  const ownerFile = path.join(lock, 'owner');
  const reap = `${lock}.reap`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 5000;
  while (true) {
    if (fs.existsSync(reap)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Leadline session lock: ${safeSessionId(sessionId)}`);
      sleep(10);
      continue;
    }
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerFile, owner, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      reclaimStaleLock(lock);
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Leadline session lock: ${safeSessionId(sessionId)}`);
      sleep(10);
    }
  }
  try {
    return callback();
  } finally {
    withReapLock(lock, () => {
      try {
        if (fs.readFileSync(ownerFile, 'utf8') === owner) {
          fs.rmSync(lock, { recursive: true, force: true });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }, true);
  }
}

function handleClaudeHook(input, options = {}) {
  const projectDir = path.resolve(options.projectDir || input?.cwd || process.cwd());
  const packageRoot = options.packageRoot || path.join(__dirname, '..');
  return withStateLock(projectDir, input?.session_id, () => (
    handleClaudeHookLocked(input, { projectDir, packageRoot })
  ));
}

function handleClaudeHookLocked(input, { projectDir, packageRoot }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Claude hook input must be an object');
  if (!HOOK_EVENTS.includes(input.hook_event_name)) throw new TypeError(`unsupported Claude hook event: ${input.hook_event_name}`);
  const root = path.resolve(projectDir || process.cwd());
  const engine = loadRuntime(root, packageRoot);
  const statePath = stateFile(root, input.session_id);
  const traces = traceFile(root, input.session_id);

  if (input.hook_event_name === 'UserPromptSubmit') {
    const rawPrompt = typeof input.prompt === 'string' ? input.prompt : '';
    const prompt = stripInjectedSpans(rawPrompt).trim();
    const turnId = `turn-${crypto.createHash('sha256').update(`${input.session_id || ''}\0${prompt}`).digest('hex').slice(0, 16)}`;
    const state = engine.begin(prompt, { sessionId: String(input.session_id || 'unknown'), turnId }).state;
    writeJsonAtomic(statePath, state);
    const context = renderInjection(state.contract);
    return context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : {};
  }

  const state = readJson(statePath, null) || emptyState(engine, input);
  if (input.hook_event_name === 'PreToolUse') {
    const decision = engine.beforeTool(state, toolCallFrom(input));
    const binding = toolBinding(input, state);
    if (!decision.block && binding) {
      state.accepted_tool_calls ||= {};
      state.accepted_tool_calls[binding.call_id] = binding;
    }
    writeJsonAtomic(statePath, state);
    appendTrace(traces, decision.trace);
    if (decision.verdict === 'ASK') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: decision.message,
        },
      };
    }
    if (decision.block) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message,
        },
      };
    }
    if (decision.verdict === 'CORRECT' && decision.message) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.message } };
    }
    return {};
  }

  if (input.hook_event_name === 'PostToolUse') {
    const binding = toolBinding(input, state);
    const accepted = binding && state.accepted_tool_calls?.[binding.call_id];
    if (!sameBinding(accepted, binding)) {
      const message = 'Receipt failed (unbound): PostToolUse must match an accepted PreToolUse call in this turn.';
      appendTrace(traces, {
        obligation: 'bind tool result to its accepted call', family: 'unknown',
        attempted: String(input.tool_name || 'unknown'), verdict: 'CORRECT',
        corrected_route: 'matching PreToolUse/PostToolUse tool_use_id and arguments',
        receipt: {
          rule_id: 'receipt-binding', satisfied: false,
          failure: 'unbound_tool_result', call_id: binding?.call_id || null,
        },
      });
      if (engine.mode === 'advisory') {
        return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
      }
      return { decision: 'block', reason: message };
    }
    const response = input.tool_response;
    const decision = engine.afterTool(state, toolCallFrom(input), {
      value: response,
      is_error: response?.is_error === true,
      error: response?.error ?? null,
      observed_at: response?.observed_at ?? null,
    });
    delete state.accepted_tool_calls[binding.call_id];
    writeJsonAtomic(statePath, state);
    appendTrace(traces, decision.trace);
    if (decision.verdict !== 'CORRECT' || !decision.message) return {};
    if (engine.mode === 'advisory') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse', additionalContext: decision.message,
        },
      };
    }
    return { decision: 'block', reason: decision.message };
  }

  const decision = engine.beforeStop(state, input.last_assistant_message || '');
  writeJsonAtomic(statePath, state);
  appendTrace(traces, decision.trace);
  if (decision.block) return { decision: 'block', reason: decision.message };
  if (decision.trace?.receipt?.anti_lockup_downgrade) return { systemMessage: decision.message };
  if (engine.mode === 'advisory' && decision.message) return { systemMessage: decision.message };
  return {};
}

function managedHookCommand(packageRoot, event) {
  const cli = path.join(packageRoot, 'bin', 'leadline.js');
  return `${shellQuote(process.execPath)} ${shellQuote(cli)} hook ${event} --project "\${CLAUDE_PROJECT_DIR}"`;
}

function planClaudeCodeInstall({ projectDir, packageRoot = path.join(__dirname, '..'), mode = 'enforce' } = {}) {
  if (!['enforce', 'advisory'].includes(mode)) throw new TypeError('mode must be enforce or advisory');
  const root = path.resolve(projectDir || process.cwd());
  const packFiles = fs.readdirSync(path.join(packageRoot, 'policy', 'packs'))
    .filter((name) => name.endsWith('.yaml')).sort();
  return {
    project: root, adapter: 'claude-code', mode, dry_run: true, hooks: [...HOOK_EVENTS],
    writes: [
      path.join(root, '.claude', 'settings.json'),
      ...packFiles.map((file) => path.join(root, '.leadline', 'packs', file)),
      path.join(root, '.leadline', 'config.yaml'),
      path.join(root, '.leadline', '.gitignore'),
    ],
  };
}

function installClaudeCode({ projectDir, packageRoot = path.join(__dirname, '..'), mode = 'enforce' } = {}) {
  const plan = planClaudeCodeInstall({ projectDir, packageRoot, mode });
  const root = plan.project;
  const claudeDir = path.join(root, '.claude');
  const leadlineDir = path.join(root, '.leadline');
  const targetPackDir = path.join(leadlineDir, 'packs');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(targetPackDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = readJson(settingsPath, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('Claude settings must be a JSON object');
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  for (const event of HOOK_EVENTS) {
    const command = managedHookCommand(packageRoot, event);
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const retained = existing.flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const hooks = group.hooks.filter((hook) => !(
        typeof hook?.command === 'string'
          && hook.command.includes('/bin/leadline.js')
          && hook.command.includes(` hook ${event} `)
      ));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    settings.hooks[event] = [...retained, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  writeJsonAtomic(settingsPath, settings);

  for (const file of fs.readdirSync(path.join(packageRoot, 'policy', 'packs')).filter((name) => name.endsWith('.yaml')).sort()) {
    fs.copyFileSync(path.join(packageRoot, 'policy', 'packs', file), path.join(targetPackDir, file));
  }
  fs.writeFileSync(path.join(leadlineDir, 'config.yaml'), [
    'schema_version: "1.0"', `mode: ${mode}`, 'adapter: claude-code', '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(path.join(leadlineDir, '.gitignore'), 'state/\ntraces/\n', { encoding: 'utf8', mode: 0o600 });
  return { project: root, adapter: 'claude-code', mode, hooks: [...HOOK_EVENTS] };
}

function readTrace(projectDir, sessionId) {
  const file = traceFile(path.resolve(projectDir), sessionId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

module.exports = {
  CLAUDE_CODE_CAPABILITIES, HOOK_EVENTS, _withStateLock: withStateLock,
  handleClaudeHook, installClaudeCode, planClaudeCodeInstall, readTrace,
  renderDecisionTrace, renderInjection, stripInjectedSpans,
};
