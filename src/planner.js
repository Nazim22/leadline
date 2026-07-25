'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const YAML = require('yaml');
const { decompose } = require('./decompose');
const { isClauseFullyExcluded, loadPolicy, matchPrompt } = require('./matcher');

const EVIDENCE_FAMILIES = new Set(['historical', 'structural', 'repository', 'runtime']);
const SEMANTIC_REASON_MAP = Object.freeze({
  below_family_floor: 'semantic_below_family_floor',
  ambiguous_family_margin: 'semantic_ambiguous_family_margin',
  abstain_veto: 'semantic_abstain_veto',
});

function inRange(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function hasCompleteDiagnostics(verdict) {
  return ['candidate_family', 'family_score', 'runner_up', 'family_margin', 'abstain_score', 'topk_agreement', 'route_gate']
    .every((field) => hasOwn(verdict, field));
}

function isValidRoutedSemanticVerdict(verdict) {
  if (!verdict || !hasCompleteDiagnostics(verdict)
      || !EVIDENCE_FAMILIES.has(verdict.family)
      || !inRange(verdict.score, -1, 1)
      || verdict.route_gate !== 'route') return false;
  if (verdict.candidate_family !== verdict.family || verdict.family_score !== verdict.score) return false;
  if (!inRange(verdict.family_score, -1, 1)
      || !EVIDENCE_FAMILIES.has(verdict.runner_up) || verdict.runner_up === verdict.family
      || !inRange(verdict.family_margin, -2, 2)
      || !inRange(verdict.abstain_score, -1, 1)
      || !inRange(verdict.topk_agreement, 0, 1)) return false;
  return true;
}

function isValidAbstainedSemanticVerdict(verdict) {
  if (!verdict || !hasCompleteDiagnostics(verdict) || verdict.family !== null || verdict.route_gate !== 'abstain') return false;
  if (!EVIDENCE_FAMILIES.has(verdict.candidate_family)
      || !inRange(verdict.family_score, -1, 1)
      || !EVIDENCE_FAMILIES.has(verdict.runner_up) || verdict.runner_up === verdict.candidate_family
      || !inRange(verdict.family_margin, -2, 2)
      || !inRange(verdict.abstain_score, -1, 1)
      || !inRange(verdict.topk_agreement, 0, 1)
      || !Object.hasOwn(SEMANTIC_REASON_MAP, verdict.abstain_reason)) return false;
  return true;
}

function extractSubject(text) {
  const patterns = [
    /\b(port\s+\d+)\s+open\b/iu,
    /(?:callers of|callees of|importers of|references to|definition of)\s+([A-Za-z_$][\w$]*(?:\(\))?)/iu,
    /(?:who calls|who imports|where is|is the)\s+([A-Za-z_$][\w$]*(?:\(\))?)/iu,
    /line\s+\d+\s+of\s+([A-Za-z0-9_./-]+)/iu,
    /\b([A-Za-z_$][\w$]*)\(\)/u,
    /\babout\s+([A-Za-z0-9_.$/-]+)/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1].replace(/\(\)$/, '');
  }
  return null;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

const RELEVANCE_STOPWORDS = new Set([
  'a', 'about', 'add', 'alive', 'already', 'an', 'and', 'are', 'at', 'be', 'been',
  'build', 'built', 'but', 'call', 'callers', 'check', 'contents', 'current', 'currently',
  'decide', 'decided', 'defined', 'definition', 'deployed', 'did', 'do', 'does', 'docstring',
  'exact', 'file', 'find', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'implementation',
  'implemented', 'imports', 'importers', 'in', 'is', 'it', 'its', 'last', 'line', 'live', 'me',
  'my', 'not', 'now', 'of', 'on', 'our', 'please', 'previously', 'references', 'responding',
  'right', 'running', 'ship', 'shipped', 'show', 'tell', 'than', 'that', 'the', 'then', 'this',
  'to', 'up', 'was', 'we', 'were', 'what', 'where', 'whether', 'which', 'who', 'why', 'with',
  'you', 'your',
]);

function extractRelevanceTokens(text, subject) {
  if (subject) return [subject];
  const tokens = text.match(/[A-Za-z_$][\w$.-]*/gu) || [];
  const useful = tokens.filter((token) => token.length > 1 && !RELEVANCE_STOPWORDS.has(token.toLocaleLowerCase()));
  return [...new Set(useful)];
}

function createPlanner({ tellsPath, routesPath, semanticClassifier = null }) {
  const tells = loadPolicy(tellsPath);
  const routes = YAML.parse(fs.readFileSync(routesPath, 'utf8'));
  if (!routes || !routes.families) throw new Error(`invalid routes policy: ${routesPath}`);
  const semanticFingerprint = semanticClassifier?.fingerprint || (semanticClassifier ? 'semantic-unversioned' : null);
  const policyVersion = `${tells.policy_version}+${routes.policy_version}${semanticFingerprint ? `+${semanticFingerprint}` : ''}`;

  // Build one evidence obligation for a clause+family. Returns {step|null, anchor}.
  // A step is only produced when a relevance anchor exists — else the obligation is
  // unresolved (an anchor-less obligation would be trivially satisfiable = gate-gaming).
  function buildStep(family, clauseText, matchText, classifiedBy, confidence, previousAnchor, semanticDiagnostics = null) {
    const route = routes.families[family];
    if (!route || !route.provider) throw new Error(`no provider configured for family: ${family}`);
    let subject = extractSubject(matchText) || extractSubject(clauseText);
    let relevanceTokens = extractRelevanceTokens(clauseText, subject);
    const isPronounFollowUp = /\b(?:it|this|that|they|them|its|their)\b/iu.test(clauseText);
    if (relevanceTokens.length === 0 && isPronounFollowUp && previousAnchor) {
      relevanceTokens = previousAnchor.tokens;
      subject = previousAnchor.subject;
    }
    if (relevanceTokens.length === 0) return { step: null, anchor: previousAnchor };
    const anchor = { subject: subject || relevanceTokens.join(' '), tokens: relevanceTokens };
    return {
      step: {
        need: family,
        provider: route.provider,
        evidence_target: { subject: subject || relevanceTokens.join(' '), question: clauseText.trim() },
        satisfaction: {
          requires_nonempty: true,
          requires_relevance_to: relevanceTokens,
          freshness: ['repository', 'runtime'].includes(family) ? 'fresh' : 'any',
        },
        confidence,
        classified_by: classifiedBy,
        source_scope: null,
        ...(semanticDiagnostics ? { semantic_diagnostics: semanticDiagnostics } : {}),
      },
      anchor,
    };
  }

  function assemble(question, turnId, steps, unmatchedClauses) {
    const numbered = steps.map((step, i) => ({ step_id: `route-${i + 1}`, ...step }));
    const abstained = numbered.length === 0;
    const abstainReason = abstained
      ? (unmatchedClauses.some((clause) => clause.reason === 'unresolved_evidence_target')
        ? 'unresolved_evidence_target'
        : (unmatchedClauses[0]?.reason || 'no_high_precision_tell'))
      : null;
    return {
      schema_version: '1.0',
      contract_id: `contract-${hash(`${turnId}\0${question}\0${policyVersion}`)}`,
      turn_id: turnId,
      question,
      policy_version: policyVersion,
      steps: numbered,
      ordered_route: numbered.map((s) => s.step_id),
      complete: unmatchedClauses.length === 0,
      unmatched_clauses: unmatchedClauses,
      first_action: numbered[0]?.provider || null,
      abstained,
      abstain_reason: abstainReason,
    };
  }

  // group tells matches by clause index → family
  function tellsByClause(matches) {
    const byClause = new Map();
    for (const m of matches) {
      if (!byClause.has(m.clause.index)) byClause.set(m.clause.index, new Map());
      const fam = byClause.get(m.clause.index);
      if (!fam.has(m.family)) fam.set(m.family, { family: m.family, first: m, matches: [] });
      fam.get(m.family).matches.push(m);
    }
    return byClause;
  }

  // Ordered clause walk shared by both paths. `classify` is null for tells-only.
  function walk(clauses, byClause, onSemantic) {
    // onSemantic(clause) → {family, score}|null, may be sync (tells) — semantic path
    // wraps this generator differently; kept as a builder returning intent per clause.
    const plan = [];
    for (let idx = 0; idx < clauses.length; idx++) {
      const clause = clauses[idx];
      const fam = byClause.get(idx);
      if (fam && fam.size) {
        const groups = [...fam.values()].sort((a, b) => a.first.span.start - b.first.span.start);
        plan.push({ idx, clause, kind: 'tells', groups });
      } else if (isClauseFullyExcluded(clause, tells)) {
        plan.push({ idx, clause, kind: 'excluded' });
      } else {
        plan.push({ idx, clause, kind: 'fallback' });
      }
    }
    return plan;
  }

  function plan(question, options = {}) {
    if (typeof question !== 'string') throw new TypeError('question must be a string');
    const turnId = options.turnId || `turn-${hash(question)}`;
    const clauses = decompose(question);
    const items = walk(clauses, tellsByClause(matchPrompt(question, tells)));
    const steps = [];
    const unmatched = [];
    let anchor = null;
    for (const item of items) {
      if (item.kind === 'tells') {
        for (const g of item.groups) {
          const r = buildStep(g.family, item.clause.text, g.first.text, `tell:${[...new Set(g.matches.map((m) => m.id))].join(',')}`, 1, anchor);
          if (r.step) { steps.push(r.step); anchor = r.anchor; }
          else unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason: 'unresolved_evidence_target' });
        }
      } else if (item.kind === 'fallback') {
        unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason: 'no_high_precision_tell' });
      }
    }
    return assemble(question, turnId, steps, unmatched);
  }

  async function planSemantic(question, options = {}) {
    if (typeof question !== 'string') throw new TypeError('question must be a string');
    if (!semanticClassifier) return plan(question, options);
    const turnId = options.turnId || `turn-${hash(question)}`;
    const clauses = decompose(question);
    const items = walk(clauses, tellsByClause(matchPrompt(question, tells)));
    const steps = [];
    const unmatched = [];
    let anchor = null;
    for (const item of items) {
      if (item.kind === 'tells') {
        for (const g of item.groups) {
          const r = buildStep(g.family, item.clause.text, g.first.text, `tell:${[...new Set(g.matches.map((m) => m.id))].join(',')}`, 1, anchor);
          if (r.step) { steps.push(r.step); anchor = r.anchor; }
          else unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason: 'unresolved_evidence_target' });
        }
      } else if (item.kind === 'fallback') {
        let verdict;
        try {
          verdict = await semanticClassifier.classify(item.clause.text);
        } catch {
          unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason: 'semantic_unavailable' });
          continue;
        }
        const routedVerdict = isValidRoutedSemanticVerdict(verdict);
        const abstainedVerdict = isValidAbstainedSemanticVerdict(verdict);
        if (!routedVerdict && !abstainedVerdict) {
          unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason: 'semantic_invalid_response' });
          continue;
        }
        if (routedVerdict) {
          const diagnostics = {
            candidate_family: verdict.candidate_family,
            family_score: verdict.family_score,
            runner_up: verdict.runner_up,
            family_margin: verdict.family_margin,
            abstain_score: verdict.abstain_score,
            topk_agreement: verdict.topk_agreement,
            route_gate: verdict.route_gate,
          };
          const confidence = Math.max(0, Math.min(1, Number(verdict.score)));
          const r = buildStep(
            verdict.family,
            item.clause.text,
            item.clause.text,
            `embedding:${semanticFingerprint}:${verdict.score}`,
            confidence,
            anchor,
            diagnostics,
          );
          if (r.step) { steps.push(r.step); anchor = r.anchor; }
          else unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason: 'unresolved_evidence_target' });
        } else {
          const reason = SEMANTIC_REASON_MAP[verdict.abstain_reason] || 'no_high_precision_tell';
          unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason });
        }
      }
    }
    return assemble(question, turnId, steps, unmatched);
  }

  return { plan, planSemantic, policyVersion, semanticEnabled: Boolean(semanticClassifier) };
}

module.exports = { createPlanner, extractSubject, extractRelevanceTokens };
