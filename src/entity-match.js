'use strict';

// LL-1 conservative entity grammar. Reference extraction and matching share these
// exact token rules: atomic identifiers match verbatim, otherwise every
// discriminative token must be present. There is no fuzzy or semantic matching.

const crypto = require('node:crypto');
const fs = require('node:fs');

const ENTITY_MATCHER_VERSION = 'entmatch-v0.2';

const GENERIC_TOKENS = Object.freeze(new Set([
  'service', 'services', 'app', 'application', 'lambda', 'function', 'fn', 'file', 'files',
  'tests', 'test', 'suite', 'code', 'module', 'api', 'endpoint', 'server',
  'the', 'a', 'an', 'of', 'for', 'to', 'and', 'or', 'is', 'are', 'was', 'were', 'it',
  'in', 'on', 'at', 'as', 'by', 'from', 'with', 'ok',
]));

const REFERENCE_RUN_RE = /[\p{L}\p{N}_./@-]+/gu;
const ATOMIC_SEPARATOR_RE = /[./_@-]/u;
const EDGE_SEPARATOR_RE = /^[.\-_/]+|[.\-_/]+$/gu;

function sourceBlobSha256(file) {
  const bytes = fs.readFileSync(file);
  return crypto.createHash('sha256')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

// Freeze the identity of the implementation actually loaded into this process.
const ENTITY_SOURCE_BLOB_SHA256 = sourceBlobSha256(__filename);

function entityMatcherSha() {
  return ENTITY_SOURCE_BLOB_SHA256;
}

function normalizeText(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase().trim();
}

function extractReferenceTerms(value) {
  const runs = normalizeText(value).match(REFERENCE_RUN_RE) || [];
  const terms = [];
  for (const run of runs) {
    const trimmed = run.replace(EDGE_SEPARATOR_RE, '');
    // Preserve meaningful two-character identifiers such as db/ci/ui while dropping
    // two-character grammatical filler that the matcher already treats as generic.
    if (trimmed.length >= 2 && !(trimmed.length === 2 && GENERIC_TOKENS.has(trimmed))) terms.push(trimmed);
  }
  return [...new Set(terms)];
}

function entityTerms(entity) {
  const terms = extractReferenceTerms(entity);
  const atomics = terms.filter((term) => term.length >= 3 && ATOMIC_SEPARATOR_RE.test(term));
  const discriminative = terms.filter((term) => !atomics.includes(term) && !GENERIC_TOKENS.has(term));
  return { atomics, discriminative };
}

function matchEntity(entity, references, { truncated = false } = {}) {
  const refs = new Set(Array.isArray(references) ? references.map(normalizeText) : []);
  const { atomics, discriminative } = entityTerms(entity);
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

  const unmatched = [...new Set([
    ...atomics.filter((atomic) => !refs.has(atomic)),
    ...discriminative.filter((token) => !refs.has(token)),
  ])];
  return {
    matched: false, method: 'none', matched_terms: [], unmatched_terms: unmatched,
    truncated: isTruncated, matcher_version: ENTITY_MATCHER_VERSION,
  };
}

module.exports = {
  ENTITY_MATCHER_VERSION,
  GENERIC_TOKENS,
  entityMatcherSha,
  extractReferenceTerms,
  matchEntity,
};
