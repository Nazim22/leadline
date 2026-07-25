'use strict';

const fs = require('node:fs');
const YAML = require('yaml');
const { decompose, overlapsRange, scanProtectedRanges } = require('./decompose');

function loadPolicy(filePath) {
  const parsed = YAML.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.tells) || !Array.isArray(parsed.negatives)) {
    throw new Error(`invalid tells policy: ${filePath}`);
  }
  return parsed;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
