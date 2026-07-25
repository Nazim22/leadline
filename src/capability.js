'use strict';

// LL-1: claim-independent evidence-contact normalization. Capability records what
// operation was attempted; execution_status records the host result; outcome_verdict
// records the capability-specific observation. Unknown never supports a claim.

const crypto = require('node:crypto');
const fs = require('node:fs');

const CAPABILITY_MAP_VERSION = 'cap-v0.2';
const NORMALIZER_VERSION = 'contact-normalizer-v0.3';

const CAPABILITIES = Object.freeze([
  'runtime.health_probe',
  'runtime.test_run',
  'repository.current_bytes',
  'repository.commit_state',
  'structural.complete_callers',
  'historical.decision_recall',
]);
const CAPABILITY_SET = new Set(CAPABILITIES);

const TEST_EXECUTABLES = new Set(['jest', 'vitest', 'pytest', 'rspec', 'phpunit']);
const READ_EXECUTABLES = new Set(['cat', 'head', 'tail', 'nl', 'grep', 'rg', 'ls']);
const GIT_READ_OPERATIONS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame']);
const COMPLETE_GRAPH_OPERATIONS = new Set([
  'code_callers', 'get_callers', 'find_callers', 'get_impact_radius', 'get_impact_radius_tool',
]);
const HEALTH_PATH_RE = /\/(?:health|live|ready)(?:[/?#]|$)/iu;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function sourceBlobSha256(file) {
  const bytes = fs.readFileSync(file);
  return crypto.createHash('sha256')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

// Bind provenance to the exact bytes that were loaded. Re-reading on every call could
// falsely label old in-memory rules with a newly-written on-disk source fingerprint.
const CAPABILITY_SOURCE_BLOB_SHA256 = sourceBlobSha256(__filename);

function capabilityMapSha() {
  return CAPABILITY_SOURCE_BLOB_SHA256;
}

function tokenizeSegment(segment) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaping = false;
  for (const char of segment) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote != null) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (token) tokens.push(token);
      token = '';
      continue;
    }
    token += char;
  }
  if (quote != null || escaping) return null;
  if (token) tokens.push(token);
  return tokens;
}

// Parse only a deliberately tiny shell subset. A sequence may contain zero or more
// leading `cd PATH &&` setup commands followed by exactly one evidence command.
// Anything whose final exit status can be contaminated is rejected rather than guessed.
function parseConservativeShell(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  if (command.includes('\n') || command.includes('\r') || command.includes('`') || command.includes('$(')) return null;

  const segments = [];
  let segment = '';
  let quote = null;
  let escaping = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaping) {
      segment += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      segment += char;
      escaping = true;
      continue;
    }
    if (quote != null) {
      segment += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === '&' && next === '&') {
      if (!segment.trim()) return null;
      segments.push(segment.trim());
      segment = '';
      index += 1;
      continue;
    }
    // Reject pipelines, OR/masking, sequencing, backgrounding, redirects, comments,
    // and grouping. These require a complete shell AST and can contaminate authority.
    if (';|&<>#()'.includes(char)) return null;
    segment += char;
  }
  if (quote != null || escaping || !segment.trim()) return null;
  segments.push(segment.trim());

  const tokenized = segments.map(tokenizeSegment);
  if (tokenized.some((tokens) => !tokens || tokens.length === 0)) return null;
  for (const setup of tokenized.slice(0, -1)) {
    if (setup.length !== 2 || setup[0] !== 'cd') return null;
  }

  const tokens = tokenized[tokenized.length - 1];
  // Environment wrappers/assignments can replace pagers, preload code, or otherwise alter
  // the executed operation. Their semantics are not authoritative without a full exec model.
  if (tokens[0] === 'env' || ASSIGNMENT_RE.test(tokens[0])) return null;
  return tokens;
}

function isTestCommand(tokens) {
  const [executable, ...args] = tokens;
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  const nonExecutingMode = lowerArgs.some((arg) => (
    ['-h', '--help', '--version', '--collect-only', '--collectonly', '--co',
      '--list', '--listtests', '--dry-run', '--dryrun', '--showconfig', '--fixtures',
      '--markers', '--if-present', '--ignore-scripts', '--no-run', '--setup-plan',
      '--setup-only', '--passwithnotests', '--allowemptytestsuite'].includes(arg)
    || arg.startsWith('--help=') || arg.startsWith('--version=')
    || arg.startsWith('--collect-only=') || arg.startsWith('--collectonly=')
    || arg.startsWith('--list=') || arg.startsWith('--listtests=')
    || arg.startsWith('--dry-run=') || arg.startsWith('--dryrun=')
    || arg === '-list' || arg.startsWith('-list=')
    || arg.startsWith('-dskiptests') || arg.startsWith('-dmaven.test.skip')
  ));
  if (nonExecutingMode || args.includes('-V') || (executable === 'gradle' && args.includes('-m'))) return false;
  if (TEST_EXECUTABLES.has(executable)) return true;
  if (executable === 'npm') return args[0] === 'test' || args[0] === 't' || (args[0] === 'run' && args[1] === 'test');
  if (executable === 'yarn' || executable === 'pnpm') return args[0] === 'test' || (args[0] === 'run' && args[1] === 'test');
  if (executable === 'node') {
    const testIndex = args.indexOf('--test');
    return testIndex >= 0 && !args.slice(0, testIndex).some((arg) => !arg.startsWith('-'));
  }
  if (executable === 'go' || executable === 'cargo') return args[0] === 'test';
  if (executable === 'mvn') return args.includes('test');
  if ((executable === 'python' || executable === 'python3') && args[0] === '-m') return args[1] === 'pytest';
  return false;
}

function parseHttpProbeArgs(executable, args) {
  const curlFlags = new Set(['-f', '--fail', '-s', '--silent', '-S', '--show-error', '-I', '--head', '-L', '--location']);
  const curlValueFlags = new Set(['-m', '--max-time', '--connect-timeout']);
  const wgetFlags = new Set(['-q', '--quiet', '--spider']);
  const wgetValueFlags = new Set(['--timeout', '--tries']);
  const flags = executable === 'curl' ? curlFlags : wgetFlags;
  const valueFlags = executable === 'curl' ? curlValueFlags : wgetValueFlags;
  let target = null;
  let hasFailFlag = executable === 'wget';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (/^https?:\/\//iu.test(arg)) {
      if (target != null || index !== args.length - 1) return null;
      target = arg;
      continue;
    }
    if (flags.has(arg) || (executable === 'curl' && /^-[fsSIL]+$/u.test(arg))) {
      // "bundle contains -f" as a linear check: the ambiguous [fsSIL]*f[fsSIL]* form
      // is polynomial under backtracking (CodeQL js/polynomial-redos).
      if (arg === '-f' || arg === '--fail' || (/^-[fsSIL]+$/u.test(arg) && arg.includes('f'))) hasFailFlag = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      index += 1;
      if (index >= args.length || !/^\d+(?:\.\d+)?$/u.test(args[index])) return null;
      continue;
    }
    if ([...valueFlags].some((flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`))) continue;
    // Unknown options are rejected: curl/wget include mutation and upload flags.
    return null;
  }
  if (!target || !HEALTH_PATH_RE.test(target)) return null;
  return { kind: executable, has_fail_flag: hasFailFlag };
}

function healthOperation(tokens) {
  const [executable, ...args] = tokens;
  if (executable === 'curl' || executable === 'wget') {
    return parseHttpProbeArgs(executable, args);
  }
  if (executable === 'systemctl' && ['is-active', 'status'].includes(args[0]) && args.length >= 2) {
    return { kind: 'systemctl', has_fail_flag: true };
  }
  if (executable === 'pct' && args[0] === 'status' && args.length >= 2) {
    return { kind: 'pct', has_fail_flag: true };
  }
  return null;
}

function isReadCommand(tokens) {
  const [executable, ...args] = tokens;
  if (!READ_EXECUTABLES.has(executable)) return false;
  if (executable === 'rg' && args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) return false;
  return true;
}

function isGitReadCommand(tokens) {
  const [executable, operation, ...args] = tokens;
  if (executable !== 'git') return false;
  if (args.some((arg) => arg === '--output' || arg.startsWith('--output=')
      || arg === '--ext-diff' || arg === '--textconv' || arg === '--no-index')) return false;
  if (GIT_READ_OPERATIONS.has(operation)) return true;
  if (operation !== 'branch') return false;
  return args.every((arg) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--contains', '--no-contains'].includes(arg));
}

function deriveBashOperation(command) {
  const tokens = parseConservativeShell(command);
  if (!tokens) return { capability: null, rule_id: 'bash.rejected', operation: null };
  if (tokens.slice(1).some((arg) => ['-h', '-V', '--help', '--version'].includes(arg)
      || arg.startsWith('--help=') || arg.startsWith('--version='))) {
    return { capability: null, rule_id: 'bash.informational_only', operation: null };
  }
  if (isTestCommand(tokens)) return { capability: 'runtime.test_run', rule_id: 'bash.test', operation: { kind: 'test' } };
  const health = healthOperation(tokens);
  if (health) return { capability: 'runtime.health_probe', rule_id: `bash.health.${health.kind}`, operation: health };
  // A health-shaped target does not make a non-probe read authoritative for another family.
  if (tokens.slice(1).some((token) => HEALTH_PATH_RE.test(token))) {
    return { capability: null, rule_id: 'bash.health-target-without-probe', operation: null };
  }
  if (isGitReadCommand(tokens)) return { capability: 'repository.commit_state', rule_id: 'bash.git-read', operation: { kind: 'git-read' } };
  if (isReadCommand(tokens)) return { capability: 'repository.current_bytes', rule_id: 'bash.file-read', operation: { kind: 'file-read' } };
  return { capability: null, rule_id: 'bash.unknown', operation: null };
}

function providerOperation({ provider, name, args } = {}) {
  if (typeof provider !== 'string' || provider.length === 0) return { capability: null, rule_id: 'provider.unknown', operation: null };
  const lowered = provider.toLowerCase();

  if (lowered === 'bash') {
    const command = args && typeof args === 'object' && !Array.isArray(args)
      ? (typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : null)
      : null;
    return deriveBashOperation(command);
  }
  if (['read', 'glob', 'grep'].includes(lowered)) {
    return { capability: 'repository.current_bytes', rule_id: `provider.${lowered}`, operation: { kind: 'native-read' } };
  }
  if (/^mcp__graphify-/u.test(lowered) || /^mcp__code-review-graph__/u.test(lowered)) {
    const providerOperationName = lowered.split('__').at(-1);
    if (typeof name !== 'string' || name.toLowerCase() !== providerOperationName) {
      return { capability: null, rule_id: 'graph.identity-mismatch', operation: null };
    }
    if (COMPLETE_GRAPH_OPERATIONS.has(providerOperationName)) {
      return { capability: 'structural.complete_callers', rule_id: `graph.${providerOperationName}`, operation: { kind: 'complete-callers' } };
    }
    return { capability: null, rule_id: 'graph.non-complete', operation: null };
  }
  const providerOperationName = lowered.split('__').at(-1);
  if (/^mcp__gbrain__/u.test(lowered) && typeof name === 'string' && name.toLowerCase() === providerOperationName
      && ['query', 'recall', 'get_page'].includes(providerOperationName)) {
    return { capability: 'historical.decision_recall', rule_id: `gbrain.${providerOperationName}`, operation: { kind: 'historical-read' } };
  }
  return { capability: null, rule_id: 'provider.unknown', operation: null };
}

function deriveCapability(toolCall = {}) {
  return providerOperation(toolCall).capability;
}

function normalizedResultFields(result) {
  const exitCode = Number.isInteger(result.exit_code) ? result.exit_code : null;
  const isError = typeof result.is_error === 'boolean' ? result.is_error : null;
  const httpStatus = Number.isInteger(result.http_status) && result.http_status >= 100 && result.http_status <= 599
    ? result.http_status : null;
  const executedTestCount = Number.isInteger(result.executed_test_count) && result.executed_test_count >= 0
    ? result.executed_test_count : null;
  // LL-1.1: test evidence trusts the adapter's structured executed-test count; free-form output is never parsed here.
  return {
    exit_code: exitCode, is_error: isError, http_status: httpStatus, executed_test_count: executedTestCount,
  };
}

function executionFromResult(result) {
  const fields = normalizedResultFields(result);
  const hasError = result.error != null && result.error !== false && result.error !== '';
  if (hasError) return { status: 'failure', reason: 'error_field', ...fields };
  if (fields.is_error === true) return { status: 'failure', reason: 'is_error_true', ...fields };
  if (fields.exit_code != null && fields.exit_code !== 0) return { status: 'failure', reason: 'exit_code_nonzero', ...fields };
  if (fields.exit_code === 0) return { status: 'success', reason: 'exit_code_zero', ...fields };
  if (fields.is_error === false) return { status: 'success', reason: 'is_error_false', ...fields };
  if (fields.http_status != null) return { status: 'success', reason: 'http_status_observed', ...fields };
  return { status: 'unknown', reason: 'status_missing', ...fields };
}

function hasNonemptyResult(result) {
  if (result.value == null) return false;
  if (typeof result.value === 'string') return result.value.trim().length > 0;
  if (Array.isArray(result.value)) return result.value.length > 0;
  if (typeof result.value === 'object') return Object.keys(result.value).length > 0;
  return true;
}

function outcomeFromContact(derived, execution, result) {
  if (derived.capability == null) return { verdict: 'unknown', reason: 'unknown_capability' };
  if (derived.capability === 'runtime.health_probe') {
    if (execution.http_status != null && ['curl', 'wget'].includes(derived.operation.kind)) {
      if (execution.http_status >= 200 && execution.http_status < 300) return { verdict: 'positive', reason: 'http_2xx' };
      if (execution.http_status >= 400) return { verdict: 'negative', reason: 'http_error_status' };
      return { verdict: 'unknown', reason: 'http_indeterminate_status' };
    }
    if (derived.operation.kind === 'pct') {
      const status = typeof result.value === 'string' ? result.value.trim().toLowerCase() : '';
      if (/^status:\s*running$/u.test(status)) return { verdict: 'positive', reason: 'pct_running' };
      if (/^status:\s*stopped$/u.test(status)) return { verdict: 'negative', reason: 'pct_stopped' };
      return { verdict: 'unknown', reason: 'pct_status_unknown' };
    }
    if (execution.exit_code != null && derived.operation.kind === 'systemctl') {
      return execution.exit_code === 0
        ? { verdict: 'positive', reason: 'probe_exit_zero' }
        : { verdict: 'negative', reason: 'probe_exit_nonzero' };
    }
    if (execution.exit_code != null && derived.operation.kind === 'wget') {
      return execution.exit_code === 0
        ? { verdict: 'positive', reason: 'probe_exit_zero' }
        : { verdict: 'negative', reason: 'probe_exit_nonzero' };
    }
    if (execution.exit_code != null && derived.operation.kind === 'curl') {
      if (execution.exit_code !== 0) return { verdict: 'negative', reason: 'probe_exit_nonzero' };
      if (derived.operation.has_fail_flag) return { verdict: 'positive', reason: 'probe_exit_zero' };
      return { verdict: 'unknown', reason: 'http_status_missing' };
    }
    return { verdict: 'unknown', reason: 'execution_status_missing' };
  }
  if (derived.capability === 'runtime.test_run') {
    if (execution.exit_code == null) return { verdict: 'unknown', reason: 'test_exit_missing' };
    if (execution.exit_code !== 0) return { verdict: 'negative', reason: 'test_exit_nonzero' };
    return execution.executed_test_count > 0
      ? { verdict: 'positive', reason: 'executed_test_count_positive' }
      : { verdict: 'unknown', reason: 'executed_test_count_missing_or_zero' };
  }
  if (execution.status === 'unknown') return { verdict: 'unknown', reason: 'execution_status_missing' };
  // A failed read/query/traversal did not observe the opposite repository, historical,
  // or structural state. It is an unknown observation, never contradiction evidence.
  if (execution.status === 'failure') return { verdict: 'unknown', reason: 'execution_failed' };
  if (derived.capability === 'structural.complete_callers' && result.truncated === true) {
    return { verdict: 'unknown', reason: 'structural_truncated' };
  }
  return hasNonemptyResult(result)
    ? { verdict: 'positive', reason: 'nonempty_result' }
    : { verdict: 'unknown', reason: 'empty_result' };
}

function normalizeEvidenceContact(toolCall, result) {
  const derived = providerOperation(toolCall);
  const execution = executionFromResult(result);
  const outcome = outcomeFromContact(derived, execution, result);
  return Object.freeze({
    capability: derived.capability,
    capability_rule_id: derived.rule_id,
    execution_status: execution.status,
    execution_reason: execution.reason,
    exit_code: execution.exit_code,
    is_error: execution.is_error,
    http_status: execution.http_status,
    executed_test_count: execution.executed_test_count,
    outcome_verdict: outcome.verdict,
    outcome_reason: outcome.reason,
    normalizer_version: NORMALIZER_VERSION,
    normalizer_blob_sha256: capabilityMapSha(),
  });
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_MAP_VERSION,
  CAPABILITY_SET,
  NORMALIZER_VERSION,
  capabilityMapSha,
  deriveCapability,
  normalizeEvidenceContact,
};
