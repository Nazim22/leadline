'use strict';

const fs = require('node:fs');
const YAML = require('yaml');
const { CAPABILITY_SET } = require('./capability');
const { OBLIGATIONS } = require('./claims');

const FAMILIES = Object.freeze(['historical', 'structural', 'repository', 'runtime']);
// Known claim pattern ids (the capability_requirements keys must be exactly these).
const PATTERN_IDS = Object.freeze(OBLIGATIONS.map((obligation) => obligation.id));

function exactKeys(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).sort().join('\u0000') === [...keys].sort().join('\u0000');
}

function loadAuthorityPolicy(file) {
  const policy = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (!exactKeys(policy, ['policy_version', 'mode', 'families', 'capability_requirements'])
      || typeof policy.policy_version !== 'string' || policy.mode !== 'shadow'
      || !exactKeys(policy.families, FAMILIES)) {
    throw new TypeError('authority policy must be exact and shadow-only');
  }
  for (const family of FAMILIES) {
    const rule = policy.families[family];
    // Families carry tier + freshness only; authoritative_sources is REMOVED (authority is derived).
    if (!exactKeys(rule, ['authority_tier', 'freshness'])
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
  // capability_requirements: pattern_id -> capabilities that authoritatively satisfy it.
  const requirements = policy.capability_requirements;
  if (!exactKeys(requirements, PATTERN_IDS)) {
    throw new TypeError('authority policy capability_requirements keys must be exactly the known claim patterns');
  }
  for (const patternId of PATTERN_IDS) {
    const caps = requirements[patternId];
    if (!Array.isArray(caps) || caps.length === 0
        || new Set(caps).size !== caps.length
        || !caps.every((capability) => CAPABILITY_SET.has(capability))) {
      throw new TypeError(`authority policy capability_requirements for ${patternId} must be a non-empty subset of CAPABILITIES`);
    }
  }
  return Object.freeze(policy);
}

// The capabilities that authoritatively satisfy a claim pattern. Unknown pattern => throw.
function requiredCapabilities(policy, patternId) {
  if (!policy || !policy.capability_requirements) throw new TypeError('policy is missing capability_requirements');
  const caps = policy.capability_requirements[patternId];
  if (!Array.isArray(caps)) throw new TypeError(`unknown claim pattern: ${patternId}`);
  return [...caps];
}

module.exports = { FAMILIES, PATTERN_IDS, loadAuthorityPolicy, requiredCapabilities };
