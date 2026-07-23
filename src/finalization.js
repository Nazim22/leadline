'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize } = require('./receipts');
const { validateEvidenceReceipt } = require('./evidence');

function normalize(value) {
  return String(value).trim().toLocaleLowerCase();
}

// Evidence-contact receipts carry observed_at at the top level (not under freshness).
// A future observed_at (raw age < 0) is NOT fresh.
function receiptFreshAtFinalization(receipt, rule, now) {
  if (rule.freshness.requirement === 'any') return true;
  if (receipt.observed_at == null) return false;
  const observed = Date.parse(receipt.observed_at);
  if (!Number.isFinite(observed)) return false;
  const age = (now.valueOf() - observed) / 1000;
  return age >= 0 && age <= rule.freshness.max_age_seconds;
}

function evaluateFinalization({ completionId, detectorResult, evidenceReceipts, policy, overrides = {}, now = new Date() } = {}) {
  if (typeof completionId !== 'string' || completionId.length === 0) throw new TypeError('completionId must be non-empty');
  if (!detectorResult || typeof detectorResult.status !== 'string' || !Array.isArray(detectorResult.obligations)) {
    throw new TypeError('detectorResult is invalid');
  }
  if (!Array.isArray(evidenceReceipts)) throw new TypeError('evidenceReceipts must be an array');
  if (!policy || policy.mode !== 'shadow' || !policy.families) throw new TypeError('finalization requires a shadow authority policy');
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('overrides must be an object map');
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new TypeError('now must be a valid Date');
  evidenceReceipts.forEach(validateEvidenceReceipt);

  const evaluations = [];
  if (detectorResult.status === 'ok') {
    for (const obligation of detectorResult.obligations) {
      const rule = policy.families[obligation.family];
      if (!rule) throw new TypeError(`unknown obligation family: ${obligation.family}`);
      const entity = normalize(obligation.entity);
      // Deterministic relevance: an authoritative provider whose contact result references the claim entity.
      const candidateContacts = evidenceReceipts.filter((receipt) => (
        rule.authoritative_sources.includes(receipt.provider)
        && receipt.references.includes(entity)
        && receipt.failure === 'none'
      ));
      const freshContacts = candidateContacts.filter((receipt) => receiptFreshAtFinalization(receipt, rule, now));
      const override = Object.prototype.hasOwnProperty.call(overrides, obligation.claim_id)
        ? overrides[obligation.claim_id] : null;

      let status;
      let matchMethod;
      let overrideProvenance = null;
      if (override != null) {
        status = 'supported';
        matchMethod = 'override';
        overrideProvenance = override;
      } else if (candidateContacts.length === 0) {
        status = 'unsupported';
        matchMethod = 'none';
      } else {
        matchMethod = 'entity_in_references';
        status = freshContacts.length > 0 ? 'supported' : 'ambiguous';
      }
      evaluations.push({
        claim_id: obligation.claim_id,
        claim: obligation.claim,
        family: obligation.family,
        entity: obligation.entity,
        matched_evidence_ids: freshContacts.map((receipt) => receipt.evidence_id),
        match_method: matchMethod,
        fresh_at_finalization: freshContacts.length > 0,
        status,
        override_provenance: overrideProvenance,
      });
    }
  }

  const supported = evaluations.filter((item) => item.status === 'supported').length;
  const unsupported = evaluations.filter((item) => item.status === 'unsupported').length;
  const ambiguous = evaluations.filter((item) => item.status === 'ambiguous').length;
  const notEvaluated = detectorResult.status === 'ok' ? 0 : detectorResult.candidate_count || 0;
  const core = {
    schema_version: '1.0',
    completion_id: completionId,
    mode: 'shadow',
    action: 'log_only',
    detector_status: detectorResult.status,
    detector_failure: detectorResult.failure || null,
    detector_fingerprint: detectorResult.detector_fingerprint,
    model_identity: detectorResult.model_identity,
    evaluated_at: now.toISOString(),
    obligations: evaluations,
    summary: { total: evaluations.length, supported, unsupported, ambiguous, not_evaluated: notEvaluated },
  };
  return {
    ...core,
    enforcement_id: `enforcement-${crypto.createHash('sha256').update(canonicalize(core)).digest('hex').slice(0, 24)}`,
  };
}

function appendFinalizationReport(file, report) {
  if (!report || report.schema_version !== '1.0' || report.mode !== 'shadow' || report.action !== 'log_only'
      || typeof report.enforcement_id !== 'string' || !Array.isArray(report.obligations)) {
    throw new TypeError('invalid finalization report');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(report)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

module.exports = { appendFinalizationReport, evaluateFinalization, receiptFreshAtFinalization };
