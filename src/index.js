'use strict';

const { decompose } = require('./decompose');
const { compilePhrase, loadPolicy, matchPrompt } = require('./matcher');
const { createPlanner, extractSubject } = require('./planner');
const { evaluateSatisfaction } = require('./satisfaction');
const { createClaimObligationDetector } = require('./claim-detector');
const { loadAuthorityPolicy, requiredCapabilities } = require('./authority');
const { deriveCapability, CAPABILITIES, CAPABILITY_MAP_VERSION, capabilityMapSha } = require('./capability');
const { matchEntity, ENTITY_MATCHER_VERSION, entityMatcherSha } = require('./entity-match');
const { appendReceipt } = require('./receipts');
const {
  appendEvidenceReceipt, createEvidenceContactReceipt, extractReferences, validateEvidenceReceipt,
} = require('./evidence');
const { appendFinalizationReport, evaluateFinalization } = require('./finalization');
const { evaluateCorpus, readJsonl, runBenchmark, scoreRoutes, scoreSatisfaction } = require('./benchmark');

module.exports = {
  CAPABILITIES,
  CAPABILITY_MAP_VERSION,
  ENTITY_MATCHER_VERSION,
  appendEvidenceReceipt,
  appendFinalizationReport,
  appendReceipt,
  capabilityMapSha,
  compilePhrase,
  createClaimObligationDetector,
  createEvidenceContactReceipt,
  createPlanner,
  decompose,
  deriveCapability,
  entityMatcherSha,
  evaluateCorpus,
  evaluateFinalization,
  evaluateSatisfaction,
  extractReferences,
  extractSubject,
  loadAuthorityPolicy,
  loadPolicy,
  matchEntity,
  matchPrompt,
  readJsonl,
  requiredCapabilities,
  runBenchmark,
  scoreRoutes,
  scoreSatisfaction,
  validateEvidenceReceipt,
};
