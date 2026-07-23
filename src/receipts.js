'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FAMILIES = new Set(['historical', 'structural', 'repository', 'runtime']);
const FAILURES = new Set(['none', 'wrong_source', 'empty', 'irrelevant', 'stale', 'error']);
const RECEIPT_KEYS = Object.freeze([
  'schema_version', 'receipt_id', 'claim_id', 'obligation_id', 'claim', 'family', 'entity',
  'source', 'authority_tier', 'tool', 'timestamp', 'freshness', 'result_hash', 'result_nonempty',
  'entity_matched', 'relevance', 'policy_decision', 'failure', 'override_provenance',
]);

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('receipt values must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new TypeError('receipt values must be JSON-compatible');
}

function hashValue(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function nonempty(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Buffer.isBuffer(value)) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function parseDate(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO date-time`);
  return new Date(value);
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || Object.keys(receipt).sort().join('\u0000') !== [...RECEIPT_KEYS].sort().join('\u0000')) {
    throw new TypeError('invalid receipt: exact object required');
  }
  const strings = ['receipt_id', 'claim_id', 'obligation_id', 'claim', 'entity', 'source', 'result_hash'];
  if (receipt.schema_version !== '1.0' || strings.some((field) => typeof receipt[field] !== 'string' || receipt[field].length === 0)) {
    throw new TypeError('invalid receipt: missing required identity fields');
  }
  if (!/^receipt-[a-f0-9]{24}$/u.test(receipt.receipt_id) || !/^[a-f0-9]{64}$/u.test(receipt.result_hash)) {
    throw new TypeError('invalid receipt: malformed hash identity');
  }
  if (!FAMILIES.has(receipt.family)
      || (receipt.authority_tier !== null && (!Number.isInteger(receipt.authority_tier) || receipt.authority_tier < 1))
      || (receipt.failure === 'wrong_source' ? receipt.authority_tier !== null : receipt.authority_tier === null)) {
    throw new TypeError('invalid receipt: family or authority tier');
  }
  if (!receipt.tool || typeof receipt.tool.provider !== 'string' || !receipt.tool.provider
      || typeof receipt.tool.name !== 'string' || !receipt.tool.name
      || !receipt.tool.args || typeof receipt.tool.args !== 'object' || Array.isArray(receipt.tool.args)) {
    throw new TypeError('invalid receipt: tool');
  }
  parseDate(receipt.timestamp, 'timestamp');
  if (!receipt.freshness || !['any', 'fresh'].includes(receipt.freshness.requirement)
      || typeof receipt.freshness.ok !== 'boolean') throw new TypeError('invalid receipt: freshness');
  if (typeof receipt.result_nonempty !== 'boolean' || typeof receipt.entity_matched !== 'boolean'
      || !receipt.relevance || typeof receipt.relevance.relevant !== 'boolean'
      || receipt.relevance.method !== 'adapter_asserted_v0' || !Array.isArray(receipt.relevance.matched_terms)) {
    throw new TypeError('invalid receipt: relevance');
  }
  if (!['satisfied', 'unsatisfied', 'override'].includes(receipt.policy_decision) || !FAILURES.has(receipt.failure)) {
    throw new TypeError('invalid receipt: decision');
  }
  if (receipt.policy_decision === 'satisfied' && receipt.failure !== 'none') throw new TypeError('invalid receipt: satisfied with failure');
  const { receipt_id: receiptId, ...core } = receipt;
  const expectedId = `receipt-${hashValue(core).slice(0, 24)}`;
  if (receiptId !== expectedId) throw new TypeError('invalid receipt: identity mismatch');
  return receipt;
}

// ponytail: superseded by the evidence-contact→claim-support link in finalization.js; retained until receipts.test.js is migrated (stage 2). Dead in the new path.
function createClaimSupportReceipt({ obligation, authority, toolCall, result, now = new Date(), override = null } = {}) {
  if (!obligation || typeof obligation.claim_id !== 'string' || !FAMILIES.has(obligation.family)
      || typeof obligation.entity !== 'string' || obligation.entity.length === 0) {
    throw new TypeError('obligation is invalid');
  }
  if (!authority || typeof authority.source !== 'string' || !authority.source
      || !Number.isInteger(authority.authority_tier) || authority.authority_tier < 1
      || !authority.freshness || !['any', 'fresh'].includes(authority.freshness.requirement)) {
    throw new TypeError('authority is invalid');
  }
  if (!toolCall || typeof toolCall.provider !== 'string' || !toolCall.provider
      || typeof toolCall.name !== 'string' || !toolCall.name
      || !toolCall.args || typeof toolCall.args !== 'object' || Array.isArray(toolCall.args)) {
    throw new TypeError('toolCall is invalid');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('result is invalid');
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new TypeError('now must be a valid Date');

  const observed = result.observed_at == null ? null : parseDate(result.observed_at, 'result.observed_at');
  // raw age may be negative for a future observed_at; record clamped (schema requires >= 0) but gate freshness on the raw sign
  const rawAgeSeconds = observed ? (now.valueOf() - observed.valueOf()) / 1000 : null;
  const ageSeconds = rawAgeSeconds == null ? null : Math.max(0, rawAgeSeconds);
  const maxAge = authority.freshness.max_age_seconds == null ? null : authority.freshness.max_age_seconds;
  if (maxAge != null && (!Number.isInteger(maxAge) || maxAge < 0)) throw new TypeError('freshness max_age_seconds is invalid');
  const freshnessOk = authority.freshness.requirement === 'any'
    || (observed != null && maxAge != null && rawAgeSeconds >= 0 && rawAgeSeconds <= maxAge);
  const resultNonempty = result.error == null && nonempty(result.value);
  const entityMatched = result.entity_matched === true;
  const matchedTerms = Array.isArray(result.matched_terms)
    ? [...new Set(result.matched_terms.filter((term) => typeof term === 'string' && term.length > 0))]
    : [];

  let failure = 'none';
  if (result.error != null) failure = 'error';
  else if (toolCall.provider !== authority.source) failure = 'wrong_source';
  else if (!resultNonempty) failure = 'empty';
  else if (!entityMatched) failure = 'irrelevant';
  else if (!freshnessOk) failure = 'stale';

  const policyDecision = override ? 'override' : failure === 'none' ? 'satisfied' : 'unsatisfied';
  const resultHash = hashValue(result.error == null ? result.value : { error: String(result.error) });
  const core = {
    schema_version: '1.0',
    claim_id: obligation.claim_id,
    obligation_id: obligation.candidate_id,
    claim: obligation.claim,
    family: obligation.family,
    entity: obligation.entity,
    source: toolCall.provider,
    // wrong-source contact is not authoritative for this family → no tier (matches validateReceipt)
    authority_tier: failure === 'wrong_source' ? null : authority.authority_tier,
    tool: { provider: toolCall.provider, name: toolCall.name, args: toolCall.args },
    timestamp: now.toISOString(),
    freshness: {
      requirement: authority.freshness.requirement,
      max_age_seconds: maxAge,
      observed_at: observed ? observed.toISOString() : null,
      age_seconds: ageSeconds,
      ok: freshnessOk,
    },
    result_hash: resultHash,
    result_nonempty: resultNonempty,
    entity_matched: entityMatched,
    relevance: { relevant: entityMatched, method: 'adapter_asserted_v0', matched_terms: matchedTerms },
    policy_decision: policyDecision,
    failure,
    override_provenance: override,
  };
  const receipt = { ...core, receipt_id: `receipt-${hashValue(core).slice(0, 24)}` };
  return validateReceipt(receipt);
}

function appendReceipt(file, receipt) {
  validateReceipt(receipt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

module.exports = { appendReceipt, canonicalize, createClaimSupportReceipt, hashValue, nonempty, parseDate, validateReceipt };
