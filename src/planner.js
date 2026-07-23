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

function createPlanner({ tellsPath, routesPath }) {
  const tells = loadPolicy(tellsPath);
  const routes = YAML.parse(fs.readFileSync(routesPath, 'utf8'));
  if (!routes || !routes.families) throw new Error(`invalid routes policy: ${routesPath}`);
  const policyVersion = `${tells.policy_version}+${routes.policy_version}`;

  function plan(question, options = {}) {
    if (typeof question !== 'string') throw new TypeError('question must be a string');
    const turnId = options.turnId || `turn-${hash(question)}`;
    const clauses = decompose(question);
    const matches = matchPrompt(question, tells);
    const byClauseAndFamily = new Map();

    for (const match of matches) {
      const key = `${match.clause.index}\0${match.family}`;
      if (!byClauseAndFamily.has(key)) {
        byClauseAndFamily.set(key, { family: match.family, first: match, matches: [] });
      }
      byClauseAndFamily.get(key).matches.push(match);
    }

    const obligations = [...byClauseAndFamily.values()].sort((a, b) => a.first.span.start - b.first.span.start);
    const steps = [];
    const unresolvedClauseIndices = new Set();
    let previousAnchor = null;

    for (const obligation of obligations) {
      const route = routes.families[obligation.family];
      if (!route || !route.provider) throw new Error(`no provider configured for family: ${obligation.family}`);
      const clause = obligation.first.clause.text;
      let subject = extractSubject(obligation.first.text) || extractSubject(clause);
      let relevanceTokens = extractRelevanceTokens(clause, subject);
      const isPronounFollowUp = /\b(?:it|this|that|they|them|its|their)\b/iu.test(clause);
      if (relevanceTokens.length === 0 && isPronounFollowUp && previousAnchor) {
        relevanceTokens = previousAnchor.tokens;
        subject = previousAnchor.subject;
      }
      if (relevanceTokens.length === 0) {
        unresolvedClauseIndices.add(obligation.first.clause.index);
        continue;
      }

      previousAnchor = { subject: subject || relevanceTokens.join(' '), tokens: relevanceTokens };
      const tellIds = [...new Set(obligation.matches.map((match) => match.id))];
      steps.push({
        step_id: `route-${steps.length + 1}`,
        need: obligation.family,
        provider: route.provider,
        evidence_target: {
          subject: subject || relevanceTokens.join(' '),
          question: clause.trim(),
        },
        satisfaction: {
          requires_nonempty: true,
          requires_relevance_to: relevanceTokens,
          freshness: ['repository', 'runtime'].includes(obligation.family) ? 'fresh' : 'any',
        },
        confidence: 1,
        classified_by: `tell:${tellIds.join(',')}`,
        source_scope: null,
      });
    }

    const matchedClauseIndices = new Set(matches.map((match) => match.clause.index));
    const unmatchedClauses = clauses.flatMap((clause, index) => {
      if (unresolvedClauseIndices.has(index)) {
        return [{ index, text: clause.text, start: clause.start, end: clause.end, reason: 'unresolved_evidence_target' }];
      }
      if (matchedClauseIndices.has(index) || isClauseFullyExcluded(clause, tells)) return [];
      return [{ index, text: clause.text, start: clause.start, end: clause.end, reason: 'no_high_precision_tell' }];
    });
    const abstained = steps.length === 0;
    const abstainReason = abstained
      ? (unmatchedClauses.some((clause) => clause.reason === 'unresolved_evidence_target')
        ? 'unresolved_evidence_target'
        : 'no_high_precision_tell')
      : null;

    return {
      schema_version: '1.0',
      contract_id: `contract-${hash(`${turnId}\0${question}\0${policyVersion}`)}`,
      turn_id: turnId,
      question,
      policy_version: policyVersion,
      steps,
      ordered_route: steps.map((step) => step.step_id),
      complete: unmatchedClauses.length === 0,
      unmatched_clauses: unmatchedClauses,
      first_action: steps[0]?.provider || null,
      abstained,
      abstain_reason: abstainReason,
    };
  }

  return { plan, policyVersion };
}

module.exports = { createPlanner, extractSubject };
