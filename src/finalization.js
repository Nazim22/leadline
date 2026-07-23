'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, validateReceipt } = require('./receipts');

function normalize(value) {
  return String(value).trim().toLocaleLowerCase();
}

function receiptFreshAtFinalization(receipt, rule, now) {
  if (rule.freshness.requirement === 'any') return true;
  if (receipt.freshness.observed_at == null) return false;
  const observed = Date.parse(receipt.freshness.observed_at);
  return Number.isFinite(observed)
    && Math.max(0, (now.valueOf() - observed) / 1000) <= rule.freshness.max_age_seconds;
}

function evaluateFinalization({ completionId, detectorResult, receipts, policy, now = new Date() } = {}) {
  if (typeof completionId !== 'string' || completionId.length === 0) throw new TypeError('completionId must be non-empty');
  if (!detectorResult || typeof detectorResult.status !== 'string' || !Array.isArray(detectorResult.obligations)) {
    throw new TypeError('detectorResult is invalid');
  }
  if (!Array.isArray(receipts)) throw new TypeError('receipts must be an array');
  if (!policy || policy.mode !== 'shadow' || !policy.families) throw new TypeError('finalization requires a shadow authority policy');
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new TypeError('now must be a valid Date');
  receipts.forEach(validateReceipt);

  const evaluations = [];
  if (detectorResult.status === 'ok') {
    for (const obligation of detectorResult.obligations) {
      const rule = policy.families[obligation.family];
      if (!rule) throw new TypeError(`unknown obligation family: ${obligation.family}`);
      const linked = receipts.filter((receipt) => (
        receipt.claim_id === obligation.claim_id
        && receipt.family === obligation.family
        && normalize(receipt.entity) === normalize(obligation.entity)
        && rule.authoritative_sources.includes(receipt.tool.provider)
      ));
      const satisfying = linked.filter((receipt) => (
        ['satisfied', 'override'].includes(receipt.policy_decision)
        && receipt.failure === 'none'
        && receiptFreshAtFinalization(receipt, rule, now)
      ));
      let reason = 'no_satisfying_receipt';
      if (satisfying.length > 0) reason = 'satisfying_receipt';
      else if (linked.some((receipt) => (
        receipt.policy_decision === 'satisfied'
        && receipt.failure === 'none'
        && !receiptFreshAtFinalization(receipt, rule, now)
      ))) reason = 'receipt_stale_at_finalization';
      else if (linked.length > 0) reason = 'receipt_unsatisfied';
      evaluations.push({
        claim_id: obligation.claim_id,
        family: obligation.family,
        entity: obligation.entity,
        claim: obligation.claim,
        status: satisfying.length > 0 ? 'supported' : 'unsupported',
        reason,
        matched_receipt_ids: satisfying.map((receipt) => receipt.receipt_id),
      });
    }
  }

  const supported = evaluations.filter((item) => item.status === 'supported').length;
  const unsupported = evaluations.filter((item) => item.status === 'unsupported').length;
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
    summary: { total: evaluations.length, supported, unsupported, not_evaluated: notEvaluated },
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
