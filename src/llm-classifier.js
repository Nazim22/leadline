'use strict';

// LLM classifier — the rubric-following semantic router. Implements the same
// classify(text) contract as the embedding classifier, so it drops into the planner.
// Uses a LOCAL model (qwen) by default: no API key, prompts stay on-box. The model is
// pluggable — set LEADLINE_LLM_MODEL or pass {model} to wire any Ollama-served model.
const { chatJSON } = require('./llm');

const FAMILIES = ['historical', 'structural', 'repository', 'runtime'];

const SYSTEM = `You are an evidence-routing classifier for a coding agent. Decide which single authoritative evidence family a user prompt EXPLICITLY requests, or abstain.

Families:
- historical: prior decisions, rationale, what was built/shipped/deployed before, or past incident state. e.g. "what did we decide", "did we ship X", "why did we choose Y", "what happened during the outage", "was it alive during the incident".
- structural: static code relationships or symbol location — callers, callees, imports, references, dependencies, where a symbol is defined, blast radius. e.g. "who calls X", "where is X defined", "what imports Y", "what depends on Z".
- repository: exact CURRENT bytes — file contents, code body, a config value, a line, a diff, commit contents, git status, or reviewing the current implementation for a bug. e.g. "show the code for X", "what does line 40 say", "review this function", "git diff".
- runtime: current live state needing a probe — is it deployed/live/responding NOW, health, port, current DB/logs/metrics, or a just-run CI/test result. e.g. "is prod up", "did the test pass", "what version is live", "is the port open".

Rules:
- Label the evidence NEED, not any tool named.
- Past/historical state = historical, NOT runtime. Exact current bytes = repository, NOT structural.
- A negated request ("don't check whether it's deployed") contributes no family.
- Use "abstain" for: direct action/build/fix/deploy/run commands with no explicit evidence request; opinions, brainstorming, design, prioritization; acknowledgements and conversational control; general web/documentation knowledge; or anything too vague to justify a family.
- Do NOT add a family just because implementing would require reading code. "clean up this function" = abstain. "review this function for the bug" = repository.

Output STRICT JSON only: {"family": "historical|structural|repository|runtime|abstain", "confidence": 0.0-1.0}. No prose.`;

async function createLLMClassifier({ model, systemPrompt = SYSTEM } = {}) {
  async function classify(text) {
    let family = null;
    let confidence = 0.5;
    try {
      const raw = await chatJSON(systemPrompt, String(text), { model });
      const o = JSON.parse(raw);
      const f = String(o.family || '').toLowerCase().trim();
      const c = Number(o.confidence);
      if (Number.isFinite(c)) confidence = Math.max(0, Math.min(1, c));
      if (FAMILIES.includes(f)) family = f;
    } catch {
      family = null; // fail open → abstain
    }
    return { family, confidence, score: confidence };
  }
  return { classify, model: model || 'default', families: FAMILIES };
}

module.exports = { createLLMClassifier, FAMILIES, SYSTEM };
