'use strict';

function evaluateSatisfaction(criteria, result) {
  const references = Array.isArray(result.references) ? result.references.map((value) => String(value).toLocaleLowerCase()) : [];
  const required = Array.isArray(criteria.requires_relevance_to)
    ? criteria.requires_relevance_to.map((value) => String(value).toLocaleLowerCase())
    : [];

  if (criteria.requires_nonempty && !result.nonempty) {
    return { satisfied: false, failure: 'empty' };
  }

  const relevant = required.length === 0 || required.some((token) => references.includes(token));
  if (!relevant) {
    return { satisfied: false, failure: 'irrelevant' };
  }

  if (criteria.freshness === 'fresh' && !result.fresh) {
    return { satisfied: false, failure: 'stale' };
  }

  return { satisfied: true, failure: 'none' };
}

module.exports = { evaluateSatisfaction };
