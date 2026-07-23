'use strict';

// Conservative multi-token entity matcher (Stage 1.2). NO fuzzy/semantic matching.
// An entity matches a receipt's references only when either an ATOMIC identifier (path,
// dotted/hyphenated/scoped symbol, versioned count) is present verbatim, OR every
// DISCRIMINATIVE word token (word tokens minus generic filler) is present in any order.
// Generic tokens alone can never support a match.

const crypto = require('node:crypto');

const ENTITY_MATCHER_VERSION = 'entmatch-v0.1';

const GENERIC_TOKENS = Object.freeze(new Set([
  'service', 'services', 'app', 'application', 'lambda', 'function', 'fn', 'file', 'files',
  'tests', 'test', 'suite', 'code', 'module', 'api', 'endpoint', 'server',
  'the', 'a', 'an', 'of', 'for', 'to', 'and',
]));

// Characters that make an identifier "atomic" (must contain at least one to be preserved whole).
const ATOMIC_SEPARATOR_RE = /[./_-]/u;
// A run of identifier characters, including path/scope/dotted/hyphenated separators.
const ATOMIC_RUN_RE = /[\w./@-]+/gu;
// Leading/trailing separators are noise (e.g. a trailing sentence period) — strip before testing.
const EDGE_SEPARATOR_RE = /^[.\-_/]+|[.\-_/]+$/gu;
// Word-token boundary: anything that is not an ASCII alphanumeric.
const WORD_BOUNDARY_RE = /[^a-z0-9]+/u;

function entityMatcherSha() {
  const basis = JSON.stringify({
    version: ENTITY_MATCHER_VERSION,
    generic: [...GENERIC_TOKENS].sort(),
  });
  return crypto.createHash('sha256').update(basis).digest('hex');
}

function extractAtomics(normalized) {
  const runs = normalized.match(ATOMIC_RUN_RE) || [];
  const atomics = [];
  for (const run of runs) {
    const trimmed = run.replace(EDGE_SEPARATOR_RE, '');
    if (trimmed.length >= 3 && ATOMIC_SEPARATOR_RE.test(trimmed)) atomics.push(trimmed);
  }
  return [...new Set(atomics)];
}

function extractDiscriminative(normalized, atomics) {
  // Remove atomic spans first so they are never split into their sub-parts.
  let remainder = normalized;
  for (const atomic of atomics) remainder = remainder.split(atomic).join(' ');
  const wordTokens = remainder.split(WORD_BOUNDARY_RE).filter((token) => token.length > 0);
  return [...new Set(wordTokens.filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token)))];
}

function matchEntity(entity, references, { truncated = false } = {}) {
  const refs = new Set(Array.isArray(references) ? references : []);
  const normalized = String(entity).normalize('NFKC').toLowerCase().trim();
  const atomics = extractAtomics(normalized);
  const discriminative = extractDiscriminative(normalized, atomics);
  const isTruncated = truncated === true;

  const atomicHit = atomics.find((atomic) => refs.has(atomic));
  if (atomicHit != null) {
    return {
      matched: true, method: 'atomic', matched_terms: [atomicHit], unmatched_terms: [],
      truncated: isTruncated, matcher_version: ENTITY_MATCHER_VERSION,
    };
  }

  if (discriminative.length > 0 && discriminative.every((token) => refs.has(token))) {
    return {
      matched: true, method: 'all_tokens', matched_terms: [...discriminative], unmatched_terms: [],
      truncated: isTruncated, matcher_version: ENTITY_MATCHER_VERSION,
    };
  }

  // Non-match: report the atomic ids + discriminative tokens that were absent from references.
  const unmatched = [...new Set([
    ...atomics.filter((atomic) => !refs.has(atomic)),
    ...discriminative.filter((token) => !refs.has(token)),
  ])];
  return {
    matched: false, method: 'none', matched_terms: [], unmatched_terms: unmatched,
    truncated: isTruncated, matcher_version: ENTITY_MATCHER_VERSION,
  };
}

module.exports = { ENTITY_MATCHER_VERSION, GENERIC_TOKENS, entityMatcherSha, matchEntity };
