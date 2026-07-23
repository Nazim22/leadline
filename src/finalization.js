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
// Order (per Item 2): (1) parse observed_at; invalid → not fresh. (2) a FUTURE observed_at
// (raw age < 0) is never fresh — this binds BEFORE the policy, so 'any' cannot rubber-stamp a
// future observation. (3) then apply policy: 'any' → fresh; 'fresh' → age <= max_age_seconds.
function receiptFreshAtFinalization(receipt, rule, now) {
  let observed = null;
  if (receipt.observed_at != null) {
    observed = Date.parse(receipt.observed_at);
    if (!Number.isFinite(observed)) return false;
    if (observed > now.valueOf()) return false;
  }
  if (rule.freshness.requirement === 'any') return true;
  if (observed == null) return false;
  return (now.valueOf() - observed) / 1000 <= rule.freshness.max_age_seconds;
}

// First failing gate for a considered receipt, in strict order (per Item 3).
function receiptDisposition(receipt, rule, entity, sessionId, turnId, now) {
  if (receipt.session_id !== sessionId || receipt.turn_id !== turnId) return 'wrong_scope';
  if (Date.parse(receipt.timestamp) > now.valueOf()) return 'future_timestamp';
  if (!rule.authoritative_sources.includes(receipt.provider)) return 'wrong_authority';
  if (receipt.failure !== 'none') return 'empty_error';
  if (!receipt.references.includes(entity)) return 'entity_mismatch';
  if (!receiptFreshAtFinalization(receipt, rule, now)) return 'stale';
  return 'supporting';
}

function evaluateFinalization({ completionId, sessionId, turnId, detectorResult, evidenceReceipts, policy, overrides = {}, now = new Date() } = {}) {
  if (typeof completionId !== 'string' || completionId.length === 0) throw new TypeError('completionId must be non-empty');
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId must be non-empty');
  if (typeof turnId !== 'string' || turnId.length === 0) throw new TypeError('turnId must be non-empty');
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
      // Considered = references the entity OR (in exact turn scope AND from an authoritative provider).
      // This bounds noise while still surfacing wrong_authority / wrong_scope / entity_mismatch classes.
      const considered = evidenceReceipts.filter((receipt) => (
        receipt.references.includes(entity)
        || (receipt.session_id === sessionId && receipt.turn_id === turnId
            && rule.authoritative_sources.includes(receipt.provider))
      ));
      const dispositions = considered.map((receipt) => ({
        evidence_id: receipt.evidence_id,
        decision: receiptDisposition(receipt, rule, entity, sessionId, turnId, now),
      }));
      const supportingIds = dispositions.filter((item) => item.decision === 'supporting').map((item) => item.evidence_id);
      const override = Object.prototype.hasOwnProperty.call(overrides, obligation.claim_id)
        ? overrides[obligation.claim_id] : null;

      let status;
      let matchMethod;
      let overrideProvenance = null;
      if (override != null) {
        status = 'supported';
        matchMethod = 'override';
        overrideProvenance = override;
      } else if (supportingIds.length > 0) {
        status = 'supported';
        matchMethod = 'entity_in_references';
      } else if (dispositions.some((item) => item.decision === 'stale')) {
        status = 'ambiguous';
        matchMethod = 'entity_in_references';
      } else {
        status = 'unsupported';
        matchMethod = 'none';
      }
      evaluations.push({
        claim_id: obligation.claim_id,
        claim: obligation.claim,
        family: obligation.family,
        entity: obligation.entity,
        candidate_evidence_ids: considered.map((receipt) => receipt.evidence_id),
        supporting_evidence_ids: supportingIds,
        dispositions,
        match_method: matchMethod,
        fresh_at_finalization: supportingIds.length > 0,
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
