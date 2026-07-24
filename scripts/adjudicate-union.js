#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const {
  LABEL_RUBRIC_PROMPT,
  MODEL_RESPONSE_SCHEMA,
  RUBRIC_SHA256,
  RUBRIC_VERSION,
  canonicalize: exportedCanonicalize,
  openAnchoredDirectory,
  readRegularNoFollow,
  validateInputs,
  writePrivate,
} = require('./label-corpus');

const ROOT = path.join(__dirname, '..');
const UNION_SEED = 'leadline-exam-v2-union-seed-20260724';
const ADJUDICATOR_MODEL = Object.freeze({
  request_model: 'google/gemini-3.6-flash',
  model_identity: 'google/gemini-3.6-flash',
});
const LANE_MODELS = Object.freeze({
  grok: Object.freeze({ request_model: 'x-ai/grok-4.5', model_identity: 'x-ai/grok-4.5' }),
  kimi: Object.freeze({ request_model: 'moonshotai/kimi-k3', model_identity: 'kimi-k3-20260715' }),
});
const FAMILIES = Object.freeze(['historical', 'structural', 'repository', 'runtime']);
const VOTES = Object.freeze(['accept', 'reject', 'abstain', 'operational_failure']);
const PROTOCOL_VERSION = 'exam-v2.0';
const MAX_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 60_000;

function canonicalize(value) {
  if (exportedCanonicalize) return exportedCanonicalize(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new TypeError('value must be canonical JSON');
}
function canonicalJsonl(rows) { return rows.length ? `${rows.map((row) => canonicalize(row)).join('\n')}\n` : ''; }
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEntity(value) {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function resolveClaims(completion, claims, laneId) {
  let cursor = 0;
  return claims.map((claim) => {
    const start = completion.indexOf(claim.span_exact_text, cursor);
    if (start < 0) throw new TypeError(`${laneId} claim is not an exact source-ordered completion span`);
    const end = start + claim.span_exact_text.length;
    cursor = end;
    return { ...claim, start, end, lane_id: laneId };
  });
}

function contains(left, right) {
  return left.start <= right.start && left.end >= right.end;
}

function candidateIdentity(seed, completionId, claim) {
  return `candidate-${sha256(canonicalize({
    seed,
    completion_id: completionId,
    start: claim.start,
    end: claim.end,
    family: claim.family,
    entity: normalizeEntity(claim.entity),
  })).slice(0, 24)}`;
}

function isRepresentedByUnion(candidate, union) {
  return union.some((existing) => (
    existing.family === candidate.family
    && normalizeEntity(existing.entity) === normalizeEntity(candidate.entity)
    && (contains(existing, candidate) || contains(candidate, existing))
  ));
}

function buildUnion({ completion_id: completionId, completion, lanes, seed = UNION_SEED }) {
  if (!completionId || typeof completion !== 'string' || !Array.isArray(lanes) || lanes.length !== 2) {
    throw new TypeError('union requires one completion and exactly two lanes');
  }
  const laneIds = lanes.map((lane) => lane.id).sort();
  if (new Set(laneIds).size !== 2) throw new TypeError('union lane IDs must be unique');
  const laneStatus = new Map(lanes.map((lane) => [lane.id, lane.status || 'ok']));
  if ([...laneStatus.values()].some((status) => !['ok', 'operational_failure'].includes(status))) {
    throw new TypeError('union lane status is invalid');
  }
  const claims = lanes.flatMap((lane) => laneStatus.get(lane.id) === 'ok'
    ? resolveClaims(completion, lane.claims || [], lane.id) : []);
  claims.sort((a, b) => a.start - b.start || b.end - a.end
    || Buffer.compare(Buffer.from(a.family), Buffer.from(b.family))
    || Buffer.compare(Buffer.from(normalizeEntity(a.entity)), Buffer.from(normalizeEntity(b.entity)))
    || Buffer.compare(Buffer.from(a.lane_id), Buffer.from(b.lane_id)));

  const clusters = [];
  for (const claim of claims) {
    const cluster = clusters.find((item) => item.family === claim.family
      && item.entity_normalized === normalizeEntity(claim.entity)
      && item.members.every((member) => contains(member, claim) || contains(claim, member)));
    if (cluster) cluster.members.push(claim);
    else clusters.push({ family: claim.family, entity_normalized: normalizeEntity(claim.entity), members: [claim] });
  }

  return clusters.map((cluster) => {
    const representative = [...cluster.members].sort((a, b) => (b.end - b.start) - (a.end - a.start)
      || a.start - b.start || Buffer.compare(Buffer.from(a.span_exact_text), Buffer.from(b.span_exact_text)))[0];
    const laneVotes = Object.fromEntries(laneIds.map((id) => [id, laneStatus.get(id) !== 'ok'
      ? 'operational_failure'
      : cluster.members.some((member) => member.lane_id === id) ? 'accept' : 'reject']));
    return {
      candidate_id: candidateIdentity(seed, completionId, representative),
      span_exact_text: representative.span_exact_text,
      family: representative.family,
      entity: representative.entity,
      start: representative.start,
      end: representative.end,
      source: 'lane_union',
      lane_votes: laneVotes,
    };
  }).sort((a, b) => a.start - b.start || b.end - a.end
    || Buffer.compare(Buffer.from(a.candidate_id), Buffer.from(b.candidate_id)));
}

function seededCandidateOrder(candidates, seed = UNION_SEED) {
  const source = [...candidates];
  const ordered = [...source].sort((a, b) => Buffer.compare(
    Buffer.from(sha256(`${seed}\0${a.candidate_id}`)),
    Buffer.from(sha256(`${seed}\0${b.candidate_id}`)),
  ));
  if (ordered.length > 1 && ordered.every((item, index) => item.candidate_id === source[index].candidate_id)) {
    ordered.push(ordered.shift());
  }
  return ordered;
}

function finalizeCandidate(votes) {
  const values = Object.values(votes);
  if (values.some((vote) => !VOTES.includes(vote))) throw new TypeError('candidate vote is invalid');
  if (values.filter((vote) => vote === 'accept').length >= 2) return 'accept';
  if (values.filter((vote) => vote === 'reject').length >= 2) return 'reject';
  return 'abstain';
}

const VOTE_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['schema_version', 'candidate_id', 'decision'],
  properties: {
    schema_version: { const: 2 },
    candidate_id: { type: 'string', pattern: '^candidate-[a-f0-9]{24}$' },
    decision: { enum: ['accept', 'reject', 'abstain'] },
  },
});
const SWEEP_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['schema_version', 'missing_claims'],
  properties: {
    schema_version: { const: 2 },
    missing_claims: { type: 'array', items: MODEL_RESPONSE_SCHEMA.properties.claims.items },
  },
});

async function fetchWithTimeout(fetchFn, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetchFn(url, { ...options, signal: controller.signal, redirect: 'error' }); }
  finally { clearTimeout(timer); }
}

async function structuredRequest({ fetchFn, endpoint, apiKey, model, schema, schemaName, payload, system, expectedCandidateId = null, validateValue = null }) {
  const validate = new Ajv2020({ strict: false }).compile(schema);
  let lastFailure = 'request_failed';
  let invalidResponseAttempts = 0;
  let operationalFailureAttempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let responseAccepted = false;
    try {
      const response = await fetchWithTimeout(fetchFn, endpoint, {
        method: 'POST',
        headers: { authorization: ['Bearer', apiKey].join(' '), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model.request_model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }],
          temperature: 0,
          seed: 0,
          provider: { require_parameters: true, allow_fallbacks: false },
          response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        }),
      });
      if (!response || !response.ok) throw new Error('request_failed');
      responseAccepted = true;
      const envelope = await response.json();
      if (!envelope || envelope.model !== model.model_identity) throw new Error('model_identity_mismatch');
      const content = envelope.choices?.[0]?.message?.content;
      const parsed = JSON.parse(content);
      if (!validate(parsed) || (expectedCandidateId !== null && parsed.candidate_id !== expectedCandidateId)) throw new Error('invalid_response');
      if (validateValue !== null) validateValue(parsed);
      return {
        status: 'ok', attempts: attempt, value: parsed, failure: null,
        invalid_response_attempts: invalidResponseAttempts,
        operational_failure_attempts: operationalFailureAttempts,
      };
    } catch (error) {
      lastFailure = error.message === 'model_identity_mismatch' ? 'model_identity_mismatch'
        : (responseAccepted ? 'invalid_response' : 'request_failed');
      if (lastFailure === 'request_failed') operationalFailureAttempts += 1;
      else invalidResponseAttempts += 1;
    }
  }
  return {
    status: 'operational_failure', attempts: MAX_ATTEMPTS, value: null, failure: lastFailure,
    invalid_response_attempts: invalidResponseAttempts,
    operational_failure_attempts: operationalFailureAttempts,
  };
}

function voteSystem() {
  return `${LABEL_RUBRIC_PROMPT}\n\nJudge exactly one opaque candidate. Return accept only if it is a real assertion and its exact span, family, and entity follow the rubric. Return reject if not. Return abstain only when the supplied predecessor and completion cannot decide. You are blind to lane identity and other candidate votes.`;
}

function sweepSystem() {
  return `${LABEL_RUBRIC_PROMPT}\n\nCompleteness sweep: inspect the entire completion and return every rubric-valid claim not already represented by any opaque candidate. Do not alter, replace, or repeat supplied candidates.`;
}

function validateAdjudicationInputs(corpusRows, contextRows, laneARows, laneBRows) {
  validateInputs(corpusRows, contextRows);
  const validateLabel = new Ajv2020({ strict: false }).compile(JSON.parse(
    readRegularNoFollow(path.join(ROOT, 'schema', 'exam-label.schema.json')).toString('utf8'),
  ));
  const expected = [
    { rows: laneARows, id: 'lane-a', ...LANE_MODELS.grok },
    { rows: laneBRows, id: 'lane-b', ...LANE_MODELS.kimi },
  ];
  const completionIds = corpusRows.map((row) => row.completion_id);
  for (const lane of expected) {
    if (!Array.isArray(lane.rows) || lane.rows.length !== corpusRows.length) throw new Error(`${lane.id} must cover every completion`);
    if (lane.rows.map((row) => row.completion_id).join('\0') !== completionIds.join('\0')) {
      throw new Error(`${lane.id} completion order and coverage must equal the corpus`);
    }
    for (const [index, row] of lane.rows.entries()) {
      if (!validateLabel(row)) throw new TypeError(`${lane.id} row ${index + 1} violates schema: ${JSON.stringify(validateLabel.errors)}`);
      if (row.rubric_sha256 !== RUBRIC_SHA256 || row.labeler.id !== lane.id
          || row.labeler.request_model !== lane.request_model || row.labeler.model_identity !== lane.model_identity) {
        throw new Error(`${lane.id} does not bind the frozen rubric and model identity`);
      }
    }
  }
}

async function runAdjudication({ corpusRows, contextRows, laneARows, laneBRows, inputHashes = null, protocol = null, apiKey, fetchFn = globalThis.fetch, endpoint = 'https://openrouter.ai/api/v1/chat/completions', seed = UNION_SEED }) {
  if (!apiKey) throw new TypeError('LEADLINE_LABELER_KEY is required');
  validateAdjudicationInputs(corpusRows, contextRows, laneARows, laneBRows);
  const context = new Map(contextRows.map((row) => [row.completion_id, row.messages]));
  const laneMaps = [new Map(laneARows.map((row) => [row.completion_id, row])), new Map(laneBRows.map((row) => [row.completion_id, row]))];
  const rows = [];
  let operationalFailures = 0;
  let invalidResponseAttempts = 0;
  let operationalFailureAttempts = 0;
  const account = (response) => {
    invalidResponseAttempts += response.invalid_response_attempts;
    operationalFailureAttempts += response.operational_failure_attempts;
    if (response.status !== 'ok') operationalFailures += 1;
  };

  for (const corpusRow of corpusRows) {
    const laneRows = laneMaps.map((lane) => lane.get(corpusRow.completion_id));
    if (laneRows.some((row) => !row)) throw new Error('lanes must cover every completion');
    const union = buildUnion({
      completion_id: corpusRow.completion_id,
      completion: corpusRow.completion,
      seed,
      lanes: laneRows.map((row) => ({ id: row.labeler.id, status: row.status, claims: row.claims })),
    });
    const ordered = seededCandidateOrder(union, seed);
    const geminiVotes = new Map();
    for (const candidate of ordered) {
      const response = await structuredRequest({
        fetchFn, endpoint, apiKey, model: ADJUDICATOR_MODEL, schema: VOTE_RESPONSE_SCHEMA,
        schemaName: 'leadline_candidate_vote_v2', system: voteSystem(),
        payload: {
          completion_id: corpusRow.completion_id,
          preceding_context: context.get(corpusRow.completion_id),
          completion: corpusRow.completion,
          candidate: {
            candidate_id: candidate.candidate_id,
            span_exact_text: candidate.span_exact_text,
            family: candidate.family,
            entity: candidate.entity,
          },
        },
        expectedCandidateId: candidate.candidate_id,
      });
      account(response);
      geminiVotes.set(candidate.candidate_id, response.status === 'ok' ? response.value.decision : 'operational_failure');
    }

    const sweep = await structuredRequest({
      fetchFn, endpoint, apiKey, model: ADJUDICATOR_MODEL, schema: SWEEP_RESPONSE_SCHEMA,
      schemaName: 'leadline_completeness_sweep_v2', system: sweepSystem(),
      payload: {
        completion_id: corpusRow.completion_id,
        preceding_context: context.get(corpusRow.completion_id),
        completion: corpusRow.completion,
        represented_candidates: union.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          span_exact_text: candidate.span_exact_text,
          family: candidate.family,
          entity: candidate.entity,
        })),
      },
      validateValue: (value) => resolveClaims(corpusRow.completion, value.missing_claims, 'gemini-sweep'),
    });
    account(sweep);
    const sweepClaims = sweep.status === 'ok' ? resolveClaims(corpusRow.completion, sweep.value.missing_claims, 'gemini-sweep') : [];
    const sweepCandidates = sweepClaims.filter((claim) => !isRepresentedByUnion(claim, union)).map((claim) => ({
      candidate_id: candidateIdentity(seed, corpusRow.completion_id, claim),
      span_exact_text: claim.span_exact_text,
      family: claim.family,
      entity: claim.entity,
      start: claim.start,
      end: claim.end,
      source: 'completeness_sweep',
      lane_votes: {},
    }));

    for (const candidate of seededCandidateOrder(sweepCandidates, seed)) {
      const validations = await Promise.all(Object.entries(LANE_MODELS).map(async ([family, model]) => {
        const response = await structuredRequest({
          fetchFn, endpoint, apiKey, model, schema: VOTE_RESPONSE_SCHEMA,
          schemaName: 'leadline_sweep_validation_v2', system: voteSystem(),
          payload: {
            completion_id: corpusRow.completion_id,
            preceding_context: context.get(corpusRow.completion_id),
            completion: corpusRow.completion,
            candidate: {
              candidate_id: candidate.candidate_id,
              span_exact_text: candidate.span_exact_text,
              family: candidate.family,
              entity: candidate.entity,
            },
          },
          expectedCandidateId: candidate.candidate_id,
        });
        account(response);
        return [family, response.status === 'ok' ? response.value.decision : 'operational_failure'];
      }));
      candidate.lane_votes = Object.fromEntries(validations);
      geminiVotes.set(candidate.candidate_id, 'accept');
    }

    const candidates = [...union, ...sweepCandidates].sort((a, b) => a.start - b.start || b.end - a.end
      || Buffer.compare(Buffer.from(a.candidate_id), Buffer.from(b.candidate_id))).map((candidate) => {
      const laneVoteValues = candidate.source === 'lane_union'
        ? { grok: candidate.lane_votes['lane-a'], kimi: candidate.lane_votes['lane-b'] }
        : candidate.lane_votes;
      const votes = { ...laneVoteValues, gemini: geminiVotes.get(candidate.candidate_id) };
      return { ...candidate, votes, decision: finalizeCandidate(votes) };
    });
    rows.push({
      completion_id: corpusRow.completion_id,
      sweep_status: sweep.status,
      candidates,
      gold_claims: candidates.filter((candidate) => candidate.decision === 'accept').map((candidate) => ({
        span_exact_text: candidate.span_exact_text, family: candidate.family, entity: candidate.entity,
      })),
    });
  }

  const pending = rows.some((row) => row.sweep_status !== 'ok' || row.candidates.some((candidate) => candidate.decision === 'abstain'));
  protocol = protocol || protocolDescriptor();
  return {
    schema_version: 2,
    protocol_version: PROTOCOL_VERSION,
    protocol_sha256: sha256(canonicalize(protocol)),
    rubric_version: RUBRIC_VERSION,
    rubric_sha256: RUBRIC_SHA256,
    seed,
    identities: { grok: LANE_MODELS.grok, kimi: LANE_MODELS.kimi, gemini: ADJUDICATOR_MODEL },
    inputs: inputHashes || {
      corpus_sha256: sha256(canonicalJsonl(corpusRows)),
      context_sha256: sha256(canonicalJsonl(contextRows)),
      lane_a_sha256: sha256(canonicalJsonl(laneARows)),
      lane_b_sha256: sha256(canonicalJsonl(laneBRows)),
      labeling_summary_sha256: '0'.repeat(64),
    },
    schema_hashes: protocol.schema_hashes,
    status: pending ? 'PENDING_ADJUDICATION' : 'COMPLETE',
    invalid_response_attempts: invalidResponseAttempts,
    operational_failure_attempts: operationalFailureAttempts,
    operational_failure_requests: operationalFailures,
    rows,
  };
}

function protocolDescriptor(readSchema = (name) => readRegularNoFollow(path.join(ROOT, 'schema', name), `schema/${name}`)) {
  const schemaNames = ['exam-label.schema.json', 'exam-adjudication.schema.json', 'exam-score.schema.json'];
  const schemaHashes = Object.fromEntries(schemaNames.map((name) => [name, sha256(readSchema(name))]));
  return {
    version: PROTOCOL_VERSION,
    rubric: { version: RUBRIC_VERSION, sha256: RUBRIC_SHA256 },
    seed: UNION_SEED,
    identities: { grok: LANE_MODELS.grok, kimi: LANE_MODELS.kimi, gemini: ADJUDICATOR_MODEL },
    clustering: 'same_family_and_nfkc_entity_plus_exact_interval_containment_only',
    ordering: 'seeded_sha256_opaque_candidate_order',
    voting: 'two_accepts_of_grok_kimi_gemini',
    sweep: 'gemini_every_completion_then_blind_grok_kimi_validation',
    schema_hashes: schemaHashes,
  };
}

function parseJsonl(text) {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.length % 2 !== 0) throw new TypeError('every option requires a value');
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!/^--[a-z][a-z-]*$/u.test(flag || '') || Object.hasOwn(values, flag.slice(2))) throw new TypeError(`invalid or duplicate option: ${flag}`);
    values[flag.slice(2)] = argv[index + 1];
  }
  const required = ['corpus', 'context', 'lane-a', 'lane-b', 'labeling-summary', 'expected-labeling-summary-sha256', 'output', 'repo', 'expected-tree'];
  for (const name of required) if (!values[name]) throw new TypeError(`--${name} is required`);
  for (const name of Object.keys(values)) if (!required.includes(name)) throw new TypeError(`unknown option: --${name}`);
  return values;
}

function help() {
  return 'Usage: node scripts/adjudicate-union.js --corpus FILE --context FILE --lane-a FILE --lane-b FILE --labeling-summary FILE --expected-labeling-summary-sha256 SHA256 --output FILE --repo DIR --expected-tree GIT_TREE\n\nRequires LEADLINE_LABELER_KEY. Seals candidate-level two-of-three adjudication plus the all-completion completeness sweep.\n';
}

function assertPathSeparation(args) {
  const output = path.resolve(args.output);
  for (const name of ['corpus', 'context', 'lane-a', 'lane-b', 'labeling-summary']) {
    if (output === path.resolve(args[name])) throw new Error(`--output must differ from --${name}`);
  }
}

async function main(argv = process.argv.slice(2), fetchFn = globalThis.fetch) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(help()); return; }
  assertPathSeparation(args);
  const repoFd = openAnchoredDirectory(path.resolve(args.repo), 'repository');
  const repoPath = `/proc/${process.pid}/fd/${repoFd}`;
  try {
    const {
      readValidatedSchema, validateLabelingSummary, validateScoringCheckout, validatedAdjudicationProtocol,
    } = require('./score-exam');
    const runtime = validateScoringCheckout(repoPath, args['expected-tree']);
    const corpusText = readRegularNoFollow(args.corpus, 'corpus').toString('utf8');
    const contextText = readRegularNoFollow(args.context, 'context').toString('utf8');
    const laneTexts = [
      readRegularNoFollow(args['lane-a'], 'lane A').toString('utf8'),
      readRegularNoFollow(args['lane-b'], 'lane B').toString('utf8'),
    ];
    const summaryText = readRegularNoFollow(args['labeling-summary'], 'labeling summary').toString('utf8');
    const corpusRows = parseJsonl(corpusText);
    const contextRows = parseJsonl(contextText);
    const laneARows = parseJsonl(laneTexts[0]);
    const laneBRows = parseJsonl(laneTexts[1]);
    const summary = JSON.parse(summaryText);
    validateLabelingSummary({
      summary, summaryText, expectedSummarySha256: args['expected-labeling-summary-sha256'],
      corpusText, contextText, laneTexts, laneRows: [laneARows, laneBRows],
    });
    const inputHashes = {
      corpus_sha256: sha256(corpusText), context_sha256: sha256(contextText),
      lane_a_sha256: sha256(laneTexts[0]), lane_b_sha256: sha256(laneTexts[1]),
      labeling_summary_sha256: sha256(summaryText),
    };
    const adjudication = await runAdjudication({
      corpusRows, contextRows, laneARows, laneBRows, inputHashes,
      protocol: validatedAdjudicationProtocol(),
      apiKey: process.env[['LEADLINE', 'LABELER', 'KEY'].join('_')], fetchFn,
    });
    const result = { ...adjudication, runtime };
    const validate = new Ajv2020({ strict: false }).compile(
      JSON.parse(readValidatedSchema('exam-adjudication.schema.json').toString('utf8')),
    );
    if (!validate(result)) throw new TypeError(`adjudication artifact violates schema: ${JSON.stringify(validate.errors)}`);
    writePrivate(args.output, `${canonicalize(result)}\n`);
    process.stdout.write(`${canonicalize({ status: result.status, rows: result.rows.length, protocol_sha256: result.protocol_sha256 })}\n`);
  } finally {
    fs.closeSync(repoFd);
  }
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`adjudicate-union: ${error.message}\n`); process.exitCode = 1; });
}

module.exports = {
  ADJUDICATOR_MODEL,
  LANE_MODELS,
  assertPathSeparation,
  PROTOCOL_VERSION,
  SWEEP_RESPONSE_SCHEMA,
  UNION_SEED,
  VOTE_RESPONSE_SCHEMA,
  buildUnion,
  candidateIdentity,
  finalizeCandidate,
  isRepresentedByUnion,
  help,
  main,
  protocolDescriptor,
  runAdjudication,
  seededCandidateOrder,
  parseArgs,
  structuredRequest,
  validateAdjudicationInputs,
};
