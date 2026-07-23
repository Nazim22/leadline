'use strict';

function trimSegment(prompt, start, end) {
  while (start < end && /\s/.test(prompt[start])) start += 1;
  while (end > start && /\s/.test(prompt[end - 1])) end -= 1;
  if (start === end) return null;
  return { text: prompt.slice(start, end), start, end };
}

/**
 * Deterministically split explicit boundaries and high-precision "and + new
 * question" boundaries. Other bare conjunctions stay intact: under-splitting is
 * safer than inventing independent obligations.
 */
function decompose(prompt) {
  if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
  if (!prompt.trim()) return [];

  const boundaries = /\s+(?:and\s+)?then\s+|,\s*(?:and|but)\s+|;\s*|\s+and\s+(?=(?:is|are|was|were|what|where|who|show|find|check|did|does|do|has|have|can|will)\b)/giu;
  const clauses = [];
  let cursor = 0;
  let match;

  while ((match = boundaries.exec(prompt)) !== null) {
    const clause = trimSegment(prompt, cursor, match.index);
    if (clause) clauses.push(clause);
    cursor = match.index + match[0].length;
  }

  const tail = trimSegment(prompt, cursor, prompt.length);
  if (tail) clauses.push(tail);
  return clauses;
}

module.exports = { decompose };
