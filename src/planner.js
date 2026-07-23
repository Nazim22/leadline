'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const YAML = require('yaml');
const { decompose } = require('./decompose');
const { isClauseFullyExcluded, loadPolicy, matchPrompt } = require('./matcher');

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
  const policyVersion = `${tells.policy_version}+${routes.policy_version}`;

  // Build one evidence obligation for a clause+family. Returns {step|null, anchor}.
  // A step is only produced when a relevance anchor exists — else the obligation is
  // unresolved (an anchor-less obligation would be trivially satisfiable = gate-gaming).
  function buildStep(family, clauseText, matchText, classifiedBy, confidence, previousAnchor) {
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
      },
      anchor,
    };
  }

  function assemble(question, turnId, steps, unmatchedClauses) {
    const numbered = steps.map((step, i) => ({ step_id: `route-${i + 1}`, ...step }));
    const abstained = numbered.length === 0;
    const abstainReason = abstained
      ? (unmatchedClauses.some((c) => c.reason === 'unresolved_evidence_target') ? 'unresolved_evidence_target' : 'no_high_precision_tell')
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
        try { verdict = await semanticClassifier.classify(item.clause.text); }
        catch { verdict = { family: null, reason: 'embed-error' }; }
        if (verdict.family) {
          const r = buildStep(verdict.family, item.clause.text, item.clause.text, `embedding:${verdict.score}`, verdict.score, anchor);
          if (r.step) { steps.push(r.step); anchor = r.anchor; }
          else unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason: 'unresolved_evidence_target' });
        } else {
          unmatched.push({ index: item.idx, text: item.clause.text, start: item.clause.start, end: item.clause.end, reason: 'no_high_precision_tell' });
        }
      }
    }
    return assemble(question, turnId, steps, unmatched);
  }

  return { plan, planSemantic, policyVersion, semanticEnabled: Boolean(semanticClassifier) };
}

module.exports = { createPlanner, extractSubject, extractRelevanceTokens };
