'use strict';

const { decompose } = require('./decompose');
const { compilePhrase, loadPolicy, matchPrompt } = require('./matcher');
const { createPlanner, extractSubject } = require('./planner');
const { evaluateSatisfaction } = require('./satisfaction');
const { createClaimObligationDetector } = require('./claim-detector');
const { loadAuthorityPolicy, resolveAuthority } = require('./authority');
const { appendReceipt, createClaimSupportReceipt } = require('./receipts');
const { appendFinalizationReport, evaluateFinalization } = require('./finalization');
const { evaluateCorpus, readJsonl, runBenchmark, scoreRoutes, scoreSatisfaction } = require('./benchmark');

module.exports = {
  appendFinalizationReport,
  appendReceipt,
  compilePhrase,
  createClaimObligationDetector,
  createClaimSupportReceipt,
  createPlanner,
  decompose,
  evaluateCorpus,
  evaluateFinalization,
  evaluateSatisfaction,
  extractSubject,
  loadAuthorityPolicy,
  loadPolicy,
  matchPrompt,
  readJsonl,
  resolveAuthority,
  runBenchmark,
  scoreRoutes,
  scoreSatisfaction,
};
