'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, hashValue, nonempty, parseDate } = require('./receipts');

// Contact-time failures are operational only. wrong_source/irrelevant/stale are CLAIM-relative
// and belong to the finalization link step, never to an evidence-contact receipt.
const FAILURES = new Set(['none', 'empty', 'error']);
const EVIDENCE_KEYS = Object.freeze([
  'schema_version', 'evidence_id', 'session_id', 'turn_id', 'tool_call_id', 'provider', 'tool_name',
  'capability', 'args_sha256', 'arg_keys', 'timestamp', 'observed_at', 'result_hash', 'result_nonempty',
  'references', 'failure',
]);

// Deterministic relevance basis: identifiers/paths/dotted names + versioned counts (e.g. "37/37").
function extractReferences(value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return [];
    }
  }
  if (typeof text !== 'string') return [];
  const identifiers = text.match(/[A-Za-z_][\w.-]{2,}/gu) || [];
  const counts = text.match(/\b\d+\/\d+\b/gu) || [];
  const set = new Set([...identifiers, ...counts].map((term) => term.toLocaleLowerCase()));
  return [...set].sort().slice(0, 200);
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
  const { evidence_id: evidenceId, ...core } = receipt;
  const expectedId = `evidence-${hashValue(core).slice(0, 24)}`;
  if (evidenceId !== expectedId) throw new TypeError('invalid evidence receipt: identity mismatch');
  return receipt;
}

function createEvidenceContactReceipt({ session_id, turn_id, tool_call_id, toolCall, result, capability = null, now = new Date() } = {}) {
  for (const [field, value] of Object.entries({ session_id, turn_id, tool_call_id })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  }
  if (!toolCall || typeof toolCall.provider !== 'string' || !toolCall.provider
      || typeof toolCall.name !== 'string' || !toolCall.name
      || !toolCall.args || typeof toolCall.args !== 'object' || Array.isArray(toolCall.args)) {
    throw new TypeError('toolCall is invalid');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('result is invalid');
  if (capability !== null && (typeof capability !== 'string' || capability.length === 0)) {
    throw new TypeError('capability must be null or a non-empty string');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new TypeError('now must be a valid Date');

  const observed = result.observed_at == null ? null : parseDate(result.observed_at, 'result.observed_at');
  const resultNonempty = result.error == null && nonempty(result.value);
  let failure = 'none';
  if (result.error != null) failure = 'error';
  else if (!resultNonempty) failure = 'empty';

  const core = {
    schema_version: '1.0',
    session_id,
    turn_id,
    tool_call_id,
    provider: toolCall.provider,
    tool_name: toolCall.name,
    // ponytail: capability is a pass-through label in stage 1; deterministic capability inference + capability-based authority matching land with the replay harness (stage 2).
    capability,
    args_sha256: hashValue(toolCall.args),
    arg_keys: [...Object.keys(toolCall.args)].sort(),
    timestamp: now.toISOString(),
    observed_at: observed ? observed.toISOString() : null,
    result_hash: hashValue(result.error == null ? result.value : { error: String(result.error) }),
    result_nonempty: resultNonempty,
    references: extractReferences(result.value),
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
module.exports = { appendEvidenceReceipt, canonicalize, createEvidenceContactReceipt, extractReferences, validateEvidenceReceipt };
