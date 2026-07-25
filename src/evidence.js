'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, hashValue, nonempty, parseDate } = require('./receipts');
const {
  CAPABILITY_SET, NORMALIZER_VERSION, capabilityMapSha, normalizeEvidenceContact,
} = require('./capability');
const { extractReferenceTerms } = require('./entity-match');

// Contact-time failures are operational only. wrong_source/irrelevant/stale are CLAIM-relative
// and belong to the finalization link step, never to an evidence-contact receipt.
const FAILURES = new Set(['none', 'empty', 'error']);
const EVIDENCE_KEYS = Object.freeze([
  'schema_version', 'evidence_id', 'session_id', 'turn_id', 'tool_call_id', 'provider', 'tool_name',
  'capability', 'capability_rule_id', 'execution_status', 'execution_reason', 'exit_code', 'is_error',
  'http_status', 'executed_test_count', 'outcome_verdict', 'outcome_reason', 'normalizer_version', 'normalizer_blob_sha256',
  'args_sha256', 'arg_keys', 'timestamp', 'observed_at', 'result_hash', 'result_nonempty',
  'references', 'references_redacted', 'references_truncated', 'failure',
]);
const EXECUTION_STATUSES = new Set(['success', 'failure', 'unknown']);
const EXECUTION_REASONS = new Set([
  'error_field', 'is_error_true', 'exit_code_nonzero', 'exit_code_zero', 'is_error_false',
  'http_status_observed', 'status_missing',
]);
const OUTCOME_VERDICTS = new Set(['positive', 'negative', 'unknown']);
const OUTCOME_REASONS = new Set([
  'unknown_capability', 'http_2xx', 'http_error_status', 'http_indeterminate_status',
  'http_status_missing', 'probe_exit_zero', 'probe_exit_nonzero', 'execution_status_missing',
  'executed_test_count_positive', 'executed_test_count_missing_or_zero', 'test_exit_nonzero', 'test_exit_missing', 'execution_failed',
  'structural_truncated', 'nonempty_result', 'empty_result', 'pct_running', 'pct_stopped',
  'pct_status_unknown',
]);

// Known secret shapes masked out of tool OUTPUT before it becomes a stored reference.
const SECRET_PATTERNS = Object.freeze([
  /sk-[A-Za-z0-9]{20,}/gu,
  /gh[pousr]_[A-Za-z0-9]{20,}/gu,
  /AKIA[0-9A-Z]{16}/gu,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  /Bearer\s+[A-Za-z0-9._-]{16,}/giu,
  /xox[baprs]-[A-Za-z0-9-]{10,}/gu,
]);
// Connection strings: mask the scheme://user:pass@ credentials, keep the rest.
const CONNECTION_CREDENTIALS = /(\w+):\/\/[^\s:@/]+:[^\s@/]+@/gu;

// Sequential scrub so overlapping shapes (e.g. Bearer wrapping a JWT) are consumed once, with a count.
function scrubSecrets(text) {
  // Normalize compatibility forms before matching. Otherwise full-width/confusable
  // credential prefixes survive redaction and are normalized into secrets downstream.
  let redacted = String(text).normalize('NFKC');
  let redactedCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => { redactedCount += 1; return ' '; });
  }
  redacted = redacted.replace(CONNECTION_CREDENTIALS, (_match, scheme) => { redactedCount += 1; return `${scheme}://***:***@`; });
  return { text: redacted, redactedCount };
}

// Named redactor: removes/masks known secret shapes from text before extraction.
function redactSecrets(text) {
  return scrubSecrets(String(text)).text;
}

// Deterministic relevance basis: identifiers/paths/dotted names + versioned counts (e.g. "37/37"),
// with secret-shaped tokens redacted first so tool OUTPUT can never persist a credential as a reference.
function extractReferences(value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return { references: [], references_redacted: 0, references_truncated: false };
    }
  }
  if (typeof text !== 'string') return { references: [], references_redacted: 0, references_truncated: false };
  const { text: redacted, redactedCount } = scrubSecrets(text);
  const set = new Set(extractReferenceTerms(redacted));
  let entropyDropped = 0;
  const kept = [];
  for (const term of set) {
    // ponytail: length+mixed-charclass entropy heuristic; a real classifier can replace it if it under/over-filters
    if (term.length >= 32 && /[a-z]/u.test(term) && /[0-9]/u.test(term)) { entropyDropped += 1; continue; }
    kept.push(term);
  }
  // references_truncated: more than 200 unique surviving terms means the reference set was capped,
  // so a non-match at the link step is ambiguity (a term may have been dropped), not a clean miss.
  return {
    references: kept.sort().slice(0, 200),
    references_redacted: redactedCount + entropyDropped,
    references_truncated: kept.length > 200,
  };
}

function validateEvidenceReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || Object.keys(receipt).sort().join('\u0000') !== [...EVIDENCE_KEYS].sort().join('\u0000')) {
    throw new TypeError('invalid evidence receipt: exact object required');
  }
  const strings = ['evidence_id', 'session_id', 'turn_id', 'tool_call_id', 'provider', 'tool_name', 'args_sha256', 'result_hash'];
  if (receipt.schema_version !== '2.1' || strings.some((field) => typeof receipt[field] !== 'string' || receipt[field].length === 0)) {
    throw new TypeError('invalid evidence receipt: missing required identity fields');
  }
  if (!/^evidence-[a-f0-9]{24}$/u.test(receipt.evidence_id)
      || !/^[a-f0-9]{64}$/u.test(receipt.args_sha256) || !/^[a-f0-9]{64}$/u.test(receipt.result_hash)) {
    throw new TypeError('invalid evidence receipt: malformed hash identity');
  }
  if (receipt.capability !== null && !CAPABILITY_SET.has(receipt.capability)) {
    throw new TypeError('invalid evidence receipt: capability must be null or a known capability');
  }
  if (typeof receipt.capability_rule_id !== 'string' || receipt.capability_rule_id.length === 0
      || !EXECUTION_STATUSES.has(receipt.execution_status) || !EXECUTION_REASONS.has(receipt.execution_reason)
      || !OUTCOME_VERDICTS.has(receipt.outcome_verdict) || !OUTCOME_REASONS.has(receipt.outcome_reason)
      || receipt.normalizer_version !== NORMALIZER_VERSION
      || receipt.normalizer_blob_sha256 !== capabilityMapSha()) {
    throw new TypeError('invalid evidence receipt: contact normalization fields');
  }
  if (receipt.exit_code !== null && !Number.isInteger(receipt.exit_code)) {
    throw new TypeError('invalid evidence receipt: exit_code');
  }
  if (receipt.is_error !== null && typeof receipt.is_error !== 'boolean') {
    throw new TypeError('invalid evidence receipt: is_error');
  }
  if (receipt.http_status !== null && (!Number.isInteger(receipt.http_status)
      || receipt.http_status < 100 || receipt.http_status > 599)) {
    throw new TypeError('invalid evidence receipt: http_status');
  }
  if (receipt.executed_test_count !== null
      && (!Number.isInteger(receipt.executed_test_count) || receipt.executed_test_count < 0)) {
    throw new TypeError('invalid evidence receipt: executed_test_count');
  }
  if (!Array.isArray(receipt.arg_keys) || !receipt.arg_keys.every((key) => typeof key === 'string' && key.length > 0)
      || !Array.isArray(receipt.references) || !receipt.references.every((term) => typeof term === 'string' && term.length > 0)) {
    throw new TypeError('invalid evidence receipt: arg_keys and references must be string arrays');
  }
  parseDate(receipt.timestamp, 'timestamp');
  if (receipt.observed_at !== null) parseDate(receipt.observed_at, 'observed_at');
  if (typeof receipt.result_nonempty !== 'boolean' || !FAILURES.has(receipt.failure)) {
    throw new TypeError('invalid evidence receipt: result_nonempty or failure');
  }
  if (!Number.isInteger(receipt.references_redacted) || receipt.references_redacted < 0) {
    throw new TypeError('invalid evidence receipt: references_redacted must be a non-negative integer');
  }
  if (typeof receipt.references_truncated !== 'boolean') {
    throw new TypeError('invalid evidence receipt: references_truncated must be a boolean');
  }
  const { evidence_id: evidenceId, ...core } = receipt;
  const expectedId = `evidence-${hashValue(core).slice(0, 24)}`;
  if (evidenceId !== expectedId) throw new TypeError('invalid evidence receipt: identity mismatch');
  return receipt;
}

function createEvidenceContactReceipt({ session_id, turn_id, tool_call_id, toolCall, result, now = new Date() } = {}) {
  for (const [field, value] of Object.entries({ session_id, turn_id, tool_call_id })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  }
  if (!toolCall || typeof toolCall.provider !== 'string' || !toolCall.provider
      || typeof toolCall.name !== 'string' || !toolCall.name
      || !toolCall.args || typeof toolCall.args !== 'object' || Array.isArray(toolCall.args)) {
    throw new TypeError('toolCall is invalid');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('result is invalid');
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new TypeError('now must be a valid Date');
  // One frozen, claim-independent normalizer is shared by live contact creation and replay.
  const normalized = normalizeEvidenceContact(toolCall, result);

  const observed = result.observed_at == null ? null : parseDate(result.observed_at, 'result.observed_at');
  const hasError = result.error != null && result.error !== false && result.error !== '';
  const resultNonempty = !hasError && nonempty(result.value);
  let failure = 'none';
  if (normalized.execution_status === 'failure') failure = 'error';
  else if (!resultNonempty) failure = 'empty';

  // Operational errors can contain the only target reference (for example a connection
  // refusal naming a service). Redact and index both value and error without storing either.
  const referenceSource = !hasError ? result.value : [result.value, String(result.error)];
  const { references, references_redacted: referencesRedacted, references_truncated: referencesTruncated } = extractReferences(referenceSource);
  const core = {
    schema_version: '2.1',
    session_id,
    turn_id,
    tool_call_id,
    provider: toolCall.provider,
    tool_name: toolCall.name,
    // Derived (not caller-asserted) capability authority; capability-based satisfaction is decided at the link step.
    ...normalized,
    args_sha256: hashValue(toolCall.args),
    arg_keys: [...Object.keys(toolCall.args)].sort(),
    timestamp: now.toISOString(),
    observed_at: observed ? observed.toISOString() : null,
    result_hash: hashValue(!hasError ? result.value : { error: String(result.error) }),
    result_nonempty: resultNonempty,
    references,
    references_redacted: referencesRedacted,
    references_truncated: referencesTruncated,
    failure,
  };
  const receipt = Object.freeze({ ...core, evidence_id: `evidence-${hashValue(core).slice(0, 24)}` });
  return validateEvidenceReceipt(receipt);
}

function appendEvidenceReceipt(file, receipt) {
  validateEvidenceReceipt(receipt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

// canonicalize is re-exported from receipts so the evidence hash basis stays single-sourced with claim-support receipts.
module.exports = { appendEvidenceReceipt, canonicalize, createEvidenceContactReceipt, extractReferences, redactSecrets, validateEvidenceReceipt };
