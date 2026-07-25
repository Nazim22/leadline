'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { deriveCapability } = require('./capability');
const { extractReferences } = require('./evidence');
const { nonempty } = require('./receipts');
const { evaluateSatisfaction } = require('./satisfaction');

const DECISIONS = Object.freeze(['ALLOW', 'DENY', 'ASK', 'CORRECT', 'ABSTAIN']);
const DECISION_SET = new Set(DECISIONS);
const FAMILIES = new Set(['historical', 'structural', 'repository', 'runtime']);
const ADAPTER_CAPABILITIES = new Set([
  'inject_before_action', 'intercept_tool_call', 'deny_tool_call', 'request_human_approval',
  'inspect_tool_result', 'block_completion',
]);
const PACK_KEYS = ['schema_version', 'id', 'version', 'description', 'required_capabilities', 'rules'];
const RULE_KEYS = [
  'id', 'trigger', 'required_family', 'preferred_route', 'sanctioned_fallback', 'satisfies',
  'denial_template', 'why', 'ttl',
];
const TEMPLATE_KEYS = ['unmet', 'corrective', 'alternative'];
const TRACE_KEYS = ['obligation', 'family', 'attempted', 'verdict', 'corrected_route', 'receipt'];

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateTrigger(trigger, where) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new TypeError(`${where}.trigger must be an object`);
  const allowed = new Set(['when_family', 'attempted_families', 'tool_names', 'input_patterns', 'obligation_patterns']);
  if (Object.keys(trigger).some((key) => !allowed.has(key))) throw new TypeError(`${where}.trigger contains an unknown field`);
  if (trigger.when_family != null && !FAMILIES.has(trigger.when_family)) throw new TypeError(`${where}.trigger.when_family is invalid`);
  for (const field of ['attempted_families', 'tool_names', 'input_patterns', 'obligation_patterns']) {
    if (trigger[field] != null && (!Array.isArray(trigger[field]) || !trigger[field].every(nonemptyString))) {
      throw new TypeError(`${where}.trigger.${field} must be a string array`);
    }
  }
  for (const field of ['tool_names', 'input_patterns', 'obligation_patterns', 'attempted_families']) {
    if (trigger[field] != null && trigger[field].length === 0) {
      throw new TypeError(`${where}.trigger.${field} must not be empty`);
    }
  }
  if (trigger.attempted_families?.some((family) => ![...FAMILIES, 'unknown'].includes(family))) {
    throw new TypeError(`${where}.trigger.attempted_families contains an invalid family`);
  }
  if (!trigger.when_family && !(trigger.tool_names?.length && trigger.input_patterns?.length)) {
    throw new TypeError(`${where}.trigger must select a family or tool input`);
  }
  for (const expression of [...(trigger.input_patterns || []), ...(trigger.obligation_patterns || [])]) {
    try { new RegExp(expression, 'iu'); } catch { throw new TypeError(`${where}.trigger contains an invalid pattern`); }
  }
}

function validatePack(pack, file) {
  if (!exactKeys(pack, PACK_KEYS)) throw new TypeError(`invalid policy pack ${file}: exact top-level fields required`);
  if (pack.schema_version !== '1.0' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(pack.id)
      || !/^\d+\.\d+\.\d+$/u.test(pack.version) || !nonemptyString(pack.description)) {
    throw new TypeError(`invalid policy pack ${file}: identity fields`);
  }
  if (!Array.isArray(pack.required_capabilities) || pack.required_capabilities.length === 0
      || new Set(pack.required_capabilities).size !== pack.required_capabilities.length
      || pack.required_capabilities.some((capability) => !ADAPTER_CAPABILITIES.has(capability))) {
    throw new TypeError(`invalid policy pack ${file}: required_capabilities`);
  }
  if (!Array.isArray(pack.rules) || pack.rules.length === 0) throw new TypeError(`invalid policy pack ${file}: rules`);
  const ruleIds = new Set();
  for (const rule of pack.rules) {
    const where = `${pack.id}.rules`;
    if (!exactKeys(rule, RULE_KEYS)) throw new TypeError(`invalid policy pack ${file}: ${where} exact fields, including why, required`);
    if (!nonemptyString(rule.id) || ruleIds.has(rule.id)) throw new TypeError(`invalid policy pack ${file}: duplicate or empty rule id`);
    ruleIds.add(rule.id);
    validateTrigger(rule.trigger, where);
    if (!FAMILIES.has(rule.required_family) || !nonemptyString(rule.preferred_route)
        || !nonemptyString(rule.sanctioned_fallback) || rule.satisfies !== 'real_result_only'
        || !nonemptyString(rule.why) || !Number.isInteger(rule.ttl) || rule.ttl < 0
        || !exactKeys(rule.denial_template, TEMPLATE_KEYS)
        || TEMPLATE_KEYS.some((key) => !nonemptyString(rule.denial_template[key]))) {
      throw new TypeError(`invalid policy pack ${file}: rule ${rule.id}, why and receipt policy are required`);
    }
  }
  return Object.freeze({ ...pack, rules: pack.rules.map((rule) => Object.freeze({ ...rule, pack_id: pack.id })) });
}

function loadPolicyPacks({ directory, schemaPath } = {}) {
  if (!nonemptyString(directory) || !nonemptyString(schemaPath)) throw new TypeError('directory and schemaPath are required');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  if (schema?.properties?.schema_version?.const !== '1.0') throw new TypeError('unsupported policy pack schema');
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
    .sort()
    .map((file) => validatePack(YAML.parse(fs.readFileSync(path.join(directory, file), 'utf8')), file));
}

function toolIdentity(toolCall) {
  return String(toolCall?.provider || toolCall?.name || 'unknown');
}

function inputText(toolCall) {
  try { return JSON.stringify(toolCall?.args || {}); } catch { return ''; }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function operationFingerprint(toolCall) {
  return canonicalValue({
    provider: String(toolCall?.provider || ''), name: String(toolCall?.name || ''),
    args: toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {},
    call_id: typeof toolCall?.call_id === 'string' ? toolCall.call_id : null,
  });
}

function inputEchoes(toolCall) {
  const echoes = new Set();
  function collect(value) {
    if (typeof value === 'string' && value.trim()) echoes.add(value.trim().toLocaleLowerCase());
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  collect(toolCall?.args);
  return echoes;
}

function hasSubstantiveResult(value, toolCall) {
  if (!nonempty(value)) return false;
  const echoes = inputEchoes(toolCall);
  const metadata = new Set([
    'observed_at', 'timestamp', 'duration_ms', 'latency_ms', 'request_id', 'tool_use_id',
    'is_error', 'error', 'status', 'status_code', 'http_status', 'success', 'ok', 'code', 'exit_code',
  ]);
  function substantive(candidate, key = '') {
    if (candidate == null || metadata.has(key.toLocaleLowerCase())) return false;
    if (typeof candidate === 'string') {
      const text = candidate.trim().toLocaleLowerCase();
      const noResult = /\b(?:no|zero)\s+(?:(?:relevant|matching)\s+)?(?:results?|matches?|records?|evidence|data|callers?|callees?|definitions?|references?|refs?|findings?|items?|entries?|rows?|hits?|pages?)\b|\b(?:nothing|not found)\b/iu.test(text);
      return text.length > 0 && !noResult && !echoes.has(text);
    }
    if (typeof candidate === 'number' || typeof candidate === 'boolean') return true;
    if (Buffer.isBuffer(candidate)) return candidate.length > 0;
    if (Array.isArray(candidate)) return candidate.some((item) => substantive(item));
    if (typeof candidate === 'object') {
      return Object.entries(candidate).some(([childKey, item]) => substantive(item, childKey));
    }
    return false;
  }
  return substantive(value);
}

function familyFor(toolCall) {
  return deriveCapability(toolCall)?.split('.')[0] || 'unknown';
}

function routeMatches(route, toolCall) {
  const configured = String(route);
  const expected = configured.toLocaleLowerCase();
  const provider = String(toolCall?.provider || '').toLocaleLowerCase();
  const name = String(toolCall?.name || '').toLocaleLowerCase();
  if (expected.startsWith('read ')) {
    const wanted = configured.slice(5).trim();
    const candidate = toolCall?.args?.file_path ?? toolCall?.args?.path;
    return provider === 'read' && typeof candidate === 'string' && candidate === wanted;
  }
  return provider === expected || name === expected || provider.endsWith(`__${expected}`);
}

function ruleMatchesOperation(rule, toolCall) {
  const trigger = rule.trigger;
  if (!trigger.tool_names?.some((name) => name.toLocaleLowerCase() === toolIdentity(toolCall).toLocaleLowerCase())) return false;
  const text = inputText(toolCall);
  return (trigger.input_patterns || []).some((expression) => new RegExp(expression, 'iu').test(text));
}

function ruleMatchesStep(rule, step) {
  if (!step || rule.trigger.when_family !== step.need) return false;
  const patterns = rule.trigger.obligation_patterns || [];
  if (patterns.length === 0) return true;
  const question = String(step.evidence_target?.question || '');
  return patterns.some((expression) => new RegExp(expression, 'iu').test(question));
}

function fill(template, values) {
  return String(template).replace(/\{([a-z_]+)\}/gu, (_match, key) => String(values[key] ?? ''));
}

function traceRow({ obligation, family, attempted = null, verdict, correctedRoute = null, receipt = null }) {
  const trace = {
    obligation, family, attempted, verdict, corrected_route: correctedRoute, receipt,
  };
  if (Object.keys(trace).join('\0') !== TRACE_KEYS.join('\0')) throw new Error('trace field order changed');
  return trace;
}

function emitDecision({ verdict, message = '', block = false, trace = null }) {
  if (!DECISION_SET.has(verdict)) throw new TypeError(`invalid Leadline verdict: ${verdict}`);
  return Object.freeze({ verdict, message, block: Boolean(block), trace });
}

function subjectFor(step) {
  return step?.evidence_target?.subject || step?.evidence_target?.question || 'the requested evidence';
}

function denialFor(rule, step, verdict, mode, attempted, extraReceipt = {}) {
  const subject = subjectFor(step);
  const values = {
    subject, why: rule.why, preferred_route: rule.preferred_route,
    sanctioned_fallback: rule.sanctioned_fallback,
  };
  const message = TEMPLATE_KEYS.map((key) => fill(rule.denial_template[key], values)).join('\n');
  return emitDecision({
    verdict: mode === 'enforce' ? verdict : 'CORRECT',
    message,
    block: mode === 'enforce' && verdict === 'DENY',
    trace: traceRow({
      obligation: step?.evidence_target?.question || subject,
      family: rule.required_family,
      attempted,
      verdict: mode === 'enforce' ? verdict : 'CORRECT',
      correctedRoute: rule.preferred_route,
      receipt: { rule_id: rule.id, pack_id: rule.pack_id, why: rule.why, ...extraReceipt },
    }),
  });
}

function currentStep(state) {
  return state.contract.steps.find((step) => !state.satisfied_step_ids.includes(step.step_id)) || null;
}

function hasFreshRuleSatisfaction(state, rule, now) {
  const at = state.satisfied_rules[rule.id];
  const age = now - at;
  return Number.isFinite(at) && age >= 0 && (rule.ttl === 0 || age <= rule.ttl * 1000);
}

function explicitAbstention(text) {
  const value = String(text || '');
  return /\b(?:abstain|cannot verify|unable to verify)\b/iu.test(value)
    && /\b(?:because|reason|due to)\b/iu.test(value);
}

function negotiateAdapterMode(capabilities = {}) {
  const canIntercept = capabilities.intercept_tool_call === true;
  const canDeny = capabilities.deny_tool_call === true;
  if (capabilities.inject_before_action === true && canIntercept && canDeny
      && capabilities.inspect_tool_result === true && capabilities.block_completion === true) return 'ENFORCE';
  if (canIntercept && canDeny) return 'PARTIAL_ENFORCE';
  if (capabilities.inject_before_action === true || canIntercept) return 'ADVISE';
  return 'AUDIT';
}

function createContractEngine({ planner, packs, mode = 'enforce', now = () => new Date() } = {}) {
  if (!planner || typeof planner.plan !== 'function') throw new TypeError('planner is required');
  if (!Array.isArray(packs)) throw new TypeError('packs must be an array');
  if (!['enforce', 'advisory'].includes(mode)) throw new TypeError('mode must be enforce or advisory');
  const rules = packs.flatMap((pack) => pack.rules);

  function begin(prompt, { sessionId, turnId } = {}) {
    if (!nonemptyString(sessionId) || !nonemptyString(turnId)) throw new TypeError('sessionId and turnId are required');
    return {
      state: {
        schema_version: '1.0', session_id: sessionId, turn_id: turnId,
        contract: planner.plan(prompt, { turnId }), mode,
        satisfied_step_ids: [], satisfied_rules: {}, pending_rule_id: null,
        rule_denials: {}, awaiting_approval_rule_id: null, awaiting_approval: null,
        stop_denials: {}, last_denial: null,
      },
    };
  }

  function beforeTool(state, toolCall) {
    const attempted = toolIdentity(toolCall);
    const timestamp = now().valueOf();
    const operationRule = rules.find((rule) => ruleMatchesOperation(rule, toolCall));
    if (operationRule && !hasFreshRuleSatisfaction(state, operationRule, timestamp)) {
      state.rule_denials ||= {};
      if (mode === 'enforce' && state.pending_rule_id === operationRule.id
          && (state.rule_denials[operationRule.id] || 0) >= 1) {
        state.awaiting_approval_rule_id = operationRule.id;
        state.awaiting_approval = {
          rule_id: operationRule.id,
          operation_fingerprint: operationFingerprint(toolCall),
        };
        return emitDecision({
          verdict: 'ASK', message: `Ask for human approval before ${attempted}; the preferred prerequisite remains ${operationRule.preferred_route}.`,
          trace: traceRow({
            obligation: 'authorize the protected operation', family: operationRule.required_family,
            attempted, verdict: 'ASK', correctedRoute: operationRule.preferred_route,
            receipt: { rule_id: operationRule.id, human_approval_requested: true },
          }),
        });
      }
      state.pending_rule_id = operationRule.id;
      state.rule_denials[operationRule.id] = (state.rule_denials[operationRule.id] || 0) + 1;
      const syntheticStep = {
        evidence_target: { question: 'read the protected-operation prerequisite', subject: '.leadline/access-map.md' },
      };
      const decision = denialFor(operationRule, syntheticStep, 'DENY', mode, attempted, { gaming_attempt: false });
      state.last_denial = { corrected_route: operationRule.preferred_route, rule_id: operationRule.id };
      return decision;
    }

    const step = currentStep(state);
    if (!step) return emitDecision({ verdict: 'ALLOW' });
    const preferredRule = rules.find((candidate) => ruleMatchesStep(candidate, step));
    const actualFamily = preferredRule && routeMatches(preferredRule.preferred_route, toolCall)
      ? preferredRule.required_family
      : familyFor(toolCall);
    const rule = rules.find((candidate) => ruleMatchesStep(candidate, step)
      && (candidate.trigger.attempted_families || []).includes(actualFamily)
      && (!candidate.trigger.tool_names?.length
        || candidate.trigger.tool_names.some((name) => name.toLocaleLowerCase() === attempted.toLocaleLowerCase())));
    if (rule && !routeMatches(rule.preferred_route, toolCall)) {
      const decision = denialFor(rule, step, 'DENY', mode, attempted, { gaming_attempt: false });
      state.last_denial = { corrected_route: rule.preferred_route, rule_id: rule.id };
      return decision;
    }
    return emitDecision({
      verdict: 'ALLOW',
      trace: traceRow({
        obligation: step.evidence_target.question, family: step.need, attempted, verdict: 'ALLOW',
        receipt: { rule_id: rule?.id || null, correction_followed: false, satisfied: false },
      }),
    });
  }

  function afterTool(state, toolCall, result) {
    const attempted = toolIdentity(toolCall);
    const pending = rules.find((rule) => rule.id === state.pending_rule_id);
    const approval = state.awaiting_approval;
    if (pending && approval?.rule_id === pending.id
        && approval.operation_fingerprint === operationFingerprint(toolCall)) {
      state.pending_rule_id = null;
      state.awaiting_approval_rule_id = null;
      state.awaiting_approval = null;
      return emitDecision({
        verdict: 'ALLOW',
        trace: traceRow({
          obligation: 'authorize the protected operation', family: pending.required_family,
          attempted, verdict: 'ALLOW', receipt: { rule_id: pending.id, satisfied: true, human_approval_followed: true },
        }),
      });
    }
    if (pending && routeMatches(pending.preferred_route, toolCall)) {
      if (hasSubstantiveResult(result?.value, toolCall) && !result?.is_error && result?.error == null) {
        state.satisfied_rules[pending.id] = now().valueOf();
        state.pending_rule_id = null;
        state.awaiting_approval_rule_id = null;
        state.awaiting_approval = null;
        return emitDecision({
          verdict: 'ALLOW',
          trace: traceRow({
            obligation: 'read the protected-operation prerequisite', family: pending.required_family,
            attempted, verdict: 'ALLOW', receipt: { rule_id: pending.id, satisfied: true, correction_followed: true },
          }),
        });
      }
      const message = `Receipt failed: run ${pending.preferred_route} and return a real non-empty result.`;
      return emitDecision({
        verdict: 'CORRECT', message,
        trace: traceRow({
          obligation: 'read the protected-operation prerequisite', family: pending.required_family,
          attempted, verdict: 'CORRECT', correctedRoute: pending.preferred_route,
          receipt: { rule_id: pending.id, satisfied: false, failure: 'empty' },
        }),
      });
    }

    const step = currentStep(state);
    if (!step) return emitDecision({ verdict: 'ALLOW' });
    const rule = rules.find((candidate) => ruleMatchesStep(candidate, step));
    const actualFamily = rule && routeMatches(rule.preferred_route, toolCall)
      ? rule.required_family
      : familyFor(toolCall);
    if (actualFamily !== step.need) {
      const message = `Receipt failed: use ${rule?.preferred_route || step.provider} and return evidence for ${subjectFor(step)}.`;
      return emitDecision({
        verdict: 'CORRECT', message,
        trace: traceRow({
          obligation: step.evidence_target.question, family: step.need, attempted, verdict: 'CORRECT',
          correctedRoute: rule?.preferred_route || step.provider,
          receipt: { rule_id: rule?.id || null, satisfied: false, failure: 'wrong_source', gaming_attempt: true },
        }),
      });
    }
    const extracted = extractReferences(result?.value);
    const observed = result?.observed_at == null ? null : Date.parse(result.observed_at);
    const ttl = rule?.ttl ?? 0;
    const age = observed == null ? null : now().valueOf() - observed;
    const fresh = observed == null || (Number.isFinite(observed) && age >= 0 && (ttl === 0 || age <= ttl * 1000));
    const satisfaction = evaluateSatisfaction(step.satisfaction, {
      nonempty: hasSubstantiveResult(result?.value, toolCall) && !result?.is_error && result?.error == null,
      references: extracted.references,
      fresh,
    });
    if (!satisfaction.satisfied) {
      const requirement = satisfaction.failure === 'empty' ? 'a real non-empty result'
        : satisfaction.failure === 'stale' ? 'a fresh result'
          : `a result relevant to ${subjectFor(step)}`;
      const message = `Receipt failed (${satisfaction.failure}): run ${rule?.preferred_route || step.provider} and return ${requirement}.`;
      return emitDecision({
        verdict: 'CORRECT', message,
        trace: traceRow({
          obligation: step.evidence_target.question, family: step.need, attempted, verdict: 'CORRECT',
          correctedRoute: rule?.preferred_route || step.provider,
          receipt: { rule_id: rule?.id || null, satisfied: false, failure: satisfaction.failure },
        }),
      });
    }
    state.satisfied_step_ids.push(step.step_id);
    const correctionFollowed = state.last_denial && routeMatches(state.last_denial.corrected_route, toolCall);
    state.last_denial = null;
    return emitDecision({
      verdict: 'ALLOW',
      trace: traceRow({
        obligation: step.evidence_target.question, family: step.need, attempted, verdict: 'ALLOW',
        receipt: { rule_id: rule?.id || null, satisfied: true, correction_followed: Boolean(correctionFollowed) },
      }),
    });
  }

  function beforeStop(state, finalMessage) {
    const pending = rules.find((rule) => rule.id === state.pending_rule_id);
    const step = currentStep(state);
    if (!pending && !step) return emitDecision({ verdict: 'ALLOW' });
    const family = pending?.required_family || step.need;
    const obligation = pending ? 'read the protected-operation prerequisite' : step.evidence_target.question;
    const route = pending?.preferred_route
      || rules.find((rule) => ruleMatchesStep(rule, step))?.preferred_route
      || step.provider;
    if (explicitAbstention(finalMessage)) {
      return emitDecision({
        verdict: 'ABSTAIN',
        trace: traceRow({ obligation, family, verdict: 'ABSTAIN', correctedRoute: route, receipt: { reason: String(finalMessage).trim() } }),
      });
    }
    const key = pending?.id || step.step_id;
    const denials = state.stop_denials[key] || 0;
    if (denials >= 2) {
      return emitDecision({
        verdict: 'CORRECT', message: `WARN: allowing completion after two Stop denials; ${obligation} remains unmet.`,
        trace: traceRow({
          obligation, family, verdict: 'CORRECT', correctedRoute: route,
          receipt: { satisfied: false, anti_lockup_downgrade: true, stop_denials: denials },
        }),
      });
    }
    state.stop_denials[key] = denials + 1;
    const message = [
      `Unmet obligation: ${obligation}.`,
      `Satisfy it via ${route}.`,
      'Alternatively, explicitly abstain and give the reason.',
    ].join('\n');
    return emitDecision({
      verdict: mode === 'enforce' ? 'DENY' : 'CORRECT', message, block: mode === 'enforce',
      trace: traceRow({
        obligation, family, verdict: mode === 'enforce' ? 'DENY' : 'CORRECT', correctedRoute: route,
        receipt: { satisfied: false, stop_denials: state.stop_denials[key] },
      }),
    });
  }

  return Object.freeze({ begin, beforeTool, afterTool, beforeStop, mode });
}

function renderDecisionTrace(rows) {
  const decisions = Array.isArray(rows) ? rows : [];
  const counts = {
    denials: decisions.filter((row) => row.verdict === 'DENY').length,
    followed: decisions.filter((row) => row.receipt?.correction_followed === true).length,
    abstentions: decisions.filter((row) => row.verdict === 'ABSTAIN').length,
    gaming: decisions.filter((row) => row.receipt?.gaming_attempt === true).length,
  };
  const lines = [
    `Leadline session — denials: ${counts.denials}; corrections followed: ${counts.followed}; abstentions: ${counts.abstentions}; gaming attempts caught: ${counts.gaming}`,
  ];
  decisions.forEach((row, index) => {
    const route = row.corrected_route ? ` -> ${row.corrected_route}` : '';
    lines.push(`${index + 1}. ${row.obligation} [${row.family}] ${row.attempted || '-'} ${row.verdict}${route}`);
  });
  return `${lines.join('\n')}\n`;
}

module.exports = {
  DECISIONS, createContractEngine, emitDecision, loadPolicyPacks, negotiateAdapterMode,
  renderDecisionTrace, validatePack,
};
