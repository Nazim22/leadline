'use strict';

const fs = require('node:fs');
const YAML = require('yaml');
const { decompose } = require('./decompose');

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

function clauseExclusions(clause, policy) {
  const lower = clause.text.toLocaleLowerCase();
  const excluded = new Set();
  for (const negative of policy.negatives) {
    if ((negative.when_clause_contains || []).some((phrase) => lower.includes(String(phrase).toLocaleLowerCase()))) {
      excluded.add(negative.excludes);
    }
  }
  return excluded;
}

function matchPrompt(prompt, policy) {
  if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
  const clauses = decompose(prompt);
  const matches = [];

  clauses.forEach((clause, clauseIndex) => {
    const excluded = clauseExclusions(clause, policy);
    policy.tells.forEach((tell, tellIndex) => {
      if (excluded.has(tell.family)) return;
      (tell.phrases || []).forEach((phrase, phraseIndex) => {
        const expression = compilePhrase(phrase);
        let match;
        while ((match = expression.exec(clause.text)) !== null) {
          const start = clause.start + match.index;
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

module.exports = { compilePhrase, loadPolicy, matchPrompt };
