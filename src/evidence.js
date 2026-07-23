'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, hashValue, nonempty, parseDate } = require('./receipts');
const { deriveCapability } = require('./capability');

// Contact-time failures are operational only. wrong_source/irrelevant/stale are CLAIM-relative
// and belong to the finalization link step, never to an evidence-contact receipt.
const FAILURES = new Set(['none', 'empty', 'error']);
const EVIDENCE_KEYS = Object.freeze([
  'schema_version', 'evidence_id', 'session_id', 'turn_id', 'tool_call_id', 'provider', 'tool_name',
  'capability', 'args_sha256', 'arg_keys', 'timestamp', 'observed_at', 'result_hash', 'result_nonempty',
  'references', 'references_redacted', 'references_truncated', 'failure',
]);

// Known secret shapes masked out of tool OUTPUT before it becomes a stored reference.
const SECRET_PATTERNS = Object.freeze([
  /sk-[A-Za-z0-9]{20,}/gu,
  /gh[pousr]_[A-Za-z0-9]{20,}/gu,
  /AKIA[0-9A-Z]{16}/gu,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{10,}/gu,
]);
// Connection strings: mask the scheme://user:pass@ credentials, keep the rest.
const CONNECTION_CREDENTIALS = /(\w+):\/\/[^\s:@/]+:[^\s@/]+@/gu;

// Sequential scrub so overlapping shapes (e.g. Bearer wrapping a JWT) are consumed once, with a count.
function scrubSecrets(text) {
  let redacted = text;
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
  const identifiers = redacted.match(/[A-Za-z_][\w.-]{2,}/gu) || [];
  const counts = redacted.match(/\b\d+\/\d+\b/gu) || [];
  const set = new Set([...identifiers, ...counts].map((term) => term.toLocaleLowerCase()));
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
  if (receipt.schema_version !== '1.0' || strings.some((field) => typeof receipt[field] !== 'string' || receipt[field].length === 0)) {
    throw new TypeError('invalid evidence receipt: missing required identity fields');
  }
  if (!/^evidence-[a-f0-9]{24}$/u.test(receipt.evidence_id)
      || !/^[a-f0-9]{64}$/u.test(receipt.args_sha256) || !/^[a-f0-9]{64}$/u.test(receipt.result_hash)) {
    throw new TypeError('invalid evidence receipt: malformed hash identity');
  }
  if (receipt.capability !== null && (typeof receipt.capability !== 'string' || receipt.capability.length === 0)) {
    throw new TypeError('invalid evidence receipt: capability must be null or a non-empty string');
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
  // Capability is DERIVED from the tool call, never caller-asserted (Dae's core invariant).
  // Unknown => null, and a null capability can never satisfy a claim at the link step.
  const capability = deriveCapability({ provider: toolCall.provider, name: toolCall.name, args: toolCall.args });

  const observed = result.observed_at == null ? null : parseDate(result.observed_at, 'result.observed_at');
  const resultNonempty = result.error == null && nonempty(result.value);
  let failure = 'none';
  if (result.error != null) failure = 'error';
  else if (!resultNonempty) failure = 'empty';

  const { references, references_redacted: referencesRedacted, references_truncated: referencesTruncated } = extractReferences(result.value);
  const core = {
    schema_version: '1.0',
    session_id,
    turn_id,
    tool_call_id,
    provider: toolCall.provider,
    tool_name: toolCall.name,
    // Derived (not caller-asserted) capability authority; capability-based satisfaction is decided at the link step.
    capability,
    args_sha256: hashValue(toolCall.args),
    arg_keys: [...Object.keys(toolCall.args)].sort(),
    timestamp: now.toISOString(),
    observed_at: observed ? observed.toISOString() : null,
    result_hash: hashValue(result.error == null ? result.value : { error: String(result.error) }),
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
