'use strict';

const fs = require('node:fs');
const YAML = require('yaml');

const FAMILIES = Object.freeze(['historical', 'structural', 'repository', 'runtime']);

function exactKeys(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).sort().join('\u0000') === [...keys].sort().join('\u0000');
}

function loadAuthorityPolicy(file) {
  const policy = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (!exactKeys(policy, ['policy_version', 'mode', 'families'])
      || typeof policy.policy_version !== 'string' || policy.mode !== 'shadow'
      || !exactKeys(policy.families, FAMILIES)) {
    throw new TypeError('authority policy must be exact and shadow-only');
  }
  for (const family of FAMILIES) {
    const rule = policy.families[family];
    if (!exactKeys(rule, ['authoritative_sources', 'authority_tier', 'freshness'])
        || !Array.isArray(rule.authoritative_sources) || rule.authoritative_sources.length === 0
        || !rule.authoritative_sources.every((source) => typeof source === 'string' && source.length > 0)
        || new Set(rule.authoritative_sources).size !== rule.authoritative_sources.length
        || !Number.isInteger(rule.authority_tier) || rule.authority_tier < 1
        || !exactKeys(rule.freshness, ['requirement', 'max_age_seconds'])
        || !['any', 'fresh'].includes(rule.freshness.requirement)) {
      throw new TypeError(`authority policy family ${family} is invalid`);
    }
    const maxAge = rule.freshness.max_age_seconds;
    if (rule.freshness.requirement === 'fresh' && (!Number.isInteger(maxAge) || maxAge < 0)) {
      throw new TypeError(`authority policy family ${family} requires a max age`);
    }
    if (rule.freshness.requirement === 'any' && maxAge !== null) {
      throw new TypeError(`authority policy family ${family} must use null max age`);
    }
  }
  return Object.freeze(policy);
}

function resolveAuthority(policy, family, provider) {
  if (!policy || !policy.families || !FAMILIES.includes(family)) throw new TypeError(`unknown claim family: ${family}`);
  if (typeof provider !== 'string' || provider.length === 0) throw new TypeError('provider must be non-empty');
  const rule = policy.families[family];
  const allowed = rule.authoritative_sources.includes(provider);
  return Object.freeze({
    source: allowed ? provider : rule.authoritative_sources[0],
    authoritative_sources: [...rule.authoritative_sources],
    authority_tier: rule.authority_tier,
    freshness: { ...rule.freshness },
  });
}

module.exports = { FAMILIES, loadAuthorityPolicy, resolveAuthority };
