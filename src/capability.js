'use strict';

// Derived capability authority (Stage 1.2). Capability is DERIVED from the tool call —
// never caller-asserted. Unknown => null, and a null capability can NEVER support a claim.
// Deterministic: same {provider, name, args-shape} => same capability.

const crypto = require('node:crypto');

const CAPABILITY_MAP_VERSION = 'cap-v0.1';

// Closed, frozen enum. Every derived capability is one of these or null.
const CAPABILITIES = Object.freeze([
  'runtime.health_probe',
  'runtime.test_run',
  'repository.current_bytes',
  'repository.commit_state',
  'structural.complete_callers',
  'historical.decision_recall',
]);
const CAPABILITY_SET = new Set(CAPABILITIES);

// Bash command classifiers (first match wins). Intentionally narrow: arbitrary Bash is NOT
// authoritative, so anything that isn't a recognised read/probe/test/commit read => null.
const BASH_TEST_RE = /\b(npm (run )?test|npm t|yarn test|pnpm test|jest|vitest|pytest|go test|cargo test|node --test|mvn test|rspec|phpunit)\b/iu;
// Word-boundary anchored: a trailing-space + \b fails when the next char is non-word (e.g. "grep -n"),
// so match the bare command token at \b and let the boundary handle argument separators.
const BASH_HEALTH_RE = /\b(curl|wget|nc|ncat|systemctl is-active|systemctl status|pct status)\b/iu;
// A probe can also be recognised by an http(s) URL or a health/live/ready path in the command.
const BASH_HEALTH_TARGET_RE = /(https?:\/\/|\/health\b|\/live\b|\/ready\b)/iu;
const BASH_COMMIT_RE = /\bgit (status|diff|log|show|rev-parse|ls-files|branch|blame)\b/iu;
const BASH_READ_RE = /\b(cat|head|tail|nl|sed|less|rg|grep|find|ls)\b/iu;

function deriveBashCapability(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  if (BASH_TEST_RE.test(command)) return 'runtime.test_run';
  if (BASH_HEALTH_RE.test(command) || BASH_HEALTH_TARGET_RE.test(command)) return 'runtime.health_probe';
  if (BASH_COMMIT_RE.test(command)) return 'repository.commit_state';
  if (BASH_READ_RE.test(command)) return 'repository.current_bytes';
  // Arbitrary Bash (process starts, mutations, unknown commands) is not authoritative.
  return null;
}

// Derive a capability from the tool call's provider + name + constrained arg/result SHAPE.
function deriveCapability({ provider, name, args } = {}) {
  if (typeof provider !== 'string' || provider.length === 0) return null;
  const lowered = provider.toLowerCase();

  if (lowered === 'bash') {
    const command = args && typeof args === 'object' && !Array.isArray(args)
      ? (typeof args.command === 'string' ? args.command
        : typeof args.cmd === 'string' ? args.cmd : null)
      : null;
    return deriveBashCapability(command);
  }
  if (lowered === 'read' || lowered === 'glob') return 'repository.current_bytes';
  // grep is a literal read of current bytes, NOT structural authority.
  if (lowered === 'grep') return 'repository.current_bytes';
  if (/^mcp__graphify-/u.test(provider) || /^mcp__code-review-graph__/u.test(provider)) {
    return 'structural.complete_callers';
  }
  if (/^mcp__gbrain__/u.test(provider) && ['query', 'recall', 'get_page'].includes(name)) {
    return 'historical.decision_recall';
  }
  return null;
}

// Deterministic, self-contained fingerprint of the rule table so stage-2 replay can lock provenance.
function capabilityMapSha() {
  const basis = JSON.stringify({
    table: 'leadline.capability-derivation',
    version: CAPABILITY_MAP_VERSION,
    capabilities: [...CAPABILITIES],
  });
  return crypto.createHash('sha256').update(basis).digest('hex');
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_MAP_VERSION,
  CAPABILITY_SET,
  capabilityMapSha,
  deriveCapability,
};
