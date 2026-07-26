'use strict';

const fs = require('node:fs');
const YAML = require('yaml');
const { decompose, overlapsRange, scanProtectedRanges } = require('./decompose');

function loadPolicy(filePath) {
  const parsed = YAML.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.tells) || !Array.isArray(parsed.negatives)) {
    throw new Error(`invalid tells policy: ${filePath}`);
  }
  // Project-registerable component nouns (issue #10 direction #3): an optional
  // companion file listing domain nouns that should behave like the built-in
  // 'API' noun for runtime probing.
  const nounsFile = `${filePath.replace(/tells\.yaml$/u, '')}component-nouns.yaml`;
  let componentNouns = [];
  try {
    const raw = YAML.parse(fs.readFileSync(nounsFile, 'utf8'));
    if (raw && Array.isArray(raw.nouns)) componentNouns = raw.nouns.map(String).filter(Boolean);
  } catch { /* optional file */ }
  parsed.componentNouns = componentNouns;
  return parsed;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Live/recorded-state qualifiers that, paired with a component noun, indicate a runtime probe.
const STATE_QUALIFIERS = ['alive', 'up', 'down', 'responding', 'responding now', 'running', 'live', 'health', 'status', 'right now', 'today', 'still', 'currently', 'any more'];

function matchComponentNoun(prompt, policy, clause, clauseIndex) {
  const matches = [];
  const nouns = policy.componentNouns || [];
  if (nouns.length === 0) return matches;
  const lower = clause.text.toLocaleLowerCase();
  const escaped = nouns.map((n) => escapeRegex(n.toLocaleLowerCase()));
  for (const noun of escaped) {
    const idx = lower.indexOf(noun);
    if (idx === -1) continue;
    const hasQualifier = STATE_QUALIFIERS.some((q) => lower.includes(q));
    if (!hasQualifier) continue;
    matches.push({
      id: 'runtime-component-noun',
      family: 'runtime',
      terminal: true,
      phrase: noun,
      text: clause.text.slice(idx, idx + noun.length),
      span: { start: clause.start + idx, end: clause.start + idx + noun.length },
      clause: { index: clauseIndex, text: clause.text, start: clause.start, end: clause.end },
    });
  }
  return matches;
}

function compilePhrase(phrase) {
  const pieces = String(phrase).split('*').map((piece) => escapeRegex(piece).replace(/\s+/g, '\\s+'));
  const wildcard = '[\\p{L}\\p{N}_.$()/:@-]+(?:\\s+[\\p{L}\\p{N}_.$()/:@-]+){0,4}?';
  const body = pieces.join(wildcard);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu');
}

function clauseExclusionRanges(clause, policy) {
  const lower = clause.text.toLocaleLowerCase();
  const ranges = [];

  for (const negative of policy.negatives) {
    for (const rawPhrase of negative.when_clause_contains || []) {
      const phrase = String(rawPhrase).toLocaleLowerCase();
      let cursor = 0;
      let start;
      while ((start = lower.indexOf(phrase, cursor)) !== -1) {
        ranges.push({ family: negative.excludes, start, end: start + phrase.length });
        cursor = start + Math.max(phrase.length, 1);
      }
    }
  }

  return ranges;
}

function clauseExclusions(clause, policy) {
  return new Set(clauseExclusionRanges(clause, policy).map((range) => range.family));
}

function isClauseFullyExcluded(clause, policy) {
  const ranges = clauseExclusionRanges(clause, policy);
  if (ranges.length === 0) return false;

  const residual = clause.text.split('');
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) residual[index] = ' ';
  }

  const substantive = residual.join('')
    .replace(/[,.;:!?()[\]{}]/g, ' ')
    .replace(/\b(?:and|but|then|just|please)\b/giu, ' ')
    .trim();
  return substantive.length === 0;
}

function matchPrompt(prompt, policy) {
  if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
  const clauses = decompose(prompt);
  const protectedRanges = scanProtectedRanges(prompt);
  const matches = [];

  clauses.forEach((clause, clauseIndex) => {
    const excludedRanges = clauseExclusionRanges(clause, policy);
    policy.tells.forEach((tell, tellIndex) => {
      (tell.phrases || []).forEach((phrase, phraseIndex) => {
        const expression = compilePhrase(phrase);
        let match;
        while ((match = expression.exec(clause.text)) !== null) {
          const localStart = match.index;
          const localEnd = localStart + match[0].length;
          const start = clause.start + localStart;
          if (overlapsRange(start, start + match[0].length, protectedRanges)) {
            if (match[0].length === 0) expression.lastIndex += 1;
            continue;
          }
          const isExcluded = excludedRanges.some((range) => (
            range.family === tell.family && localStart < range.end && localEnd > range.start
          ));
          if (isExcluded) {
            if (match[0].length === 0) expression.lastIndex += 1;
            continue;
          }

          matches.push({
            id: tell.id,
            family: tell.family,
            terminal: Boolean(tell.terminal),
            phrase,
            text: prompt.slice(start, start + match[0].length),
            span: { start, end: start + match[0].length },
            clause: { index: clauseIndex, text: clause.text, start: clause.start, end: clause.end },
            _order: [tellIndex, phraseIndex],
          });
          if (match[0].length === 0) expression.lastIndex += 1;
        }
      });
    });
    // Issue #10 direction #3: project-registerable component nouns behave like
    // the built-in 'API' noun when paired with a live/recorded-state qualifier.
    if ((policy.componentNouns || []).length > 0) {
      matchComponentNoun(prompt, policy, clause, clauseIndex).forEach((m) => matches.push(m));
    }
  });

  matches.sort((a, b) => a.span.start - b.span.start || a._order[0] - b._order[0] || a._order[1] - b._order[1]);
  return matches.map(({ _order, ...match }) => match);
}

module.exports = {
  clauseExclusionRanges,
  clauseExclusions,
  compilePhrase,
  isClauseFullyExcluded,
  loadPolicy,
  matchPrompt,
};
