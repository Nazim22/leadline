# Leadline — design

Self-contained design summary. Leadline is a standalone runtime; it does **not** import any host-specific context system.

## Core abstraction: the Evidence Route Contract
Per turn, Leadline emits an ordered, auditable plan (see `schema/route-contract.schema.json`). Routes are **not** mutually exclusive — the output is an ordered list of evidence obligations, not a single label.

Evidence families (generic, publishable):
- **historical** — what was decided/built/shipped
- **structural** — what calls/imports/depends
- **repository** — exact current bytes/config
- **runtime** — what is alive/deployed/responding

Providers (in `policy/routes.yaml`) map families → your tools. That mapping is the only host-specific part.

## Pipeline
`decompose → high-precision tells → embedding candidate ranking → policy/availability arbiter → ordered contract → hook enforcement + use receipts → reviewed outcome adaptation`

- **Decompose** — split explicit clause/sequencing boundaries deterministically; prefer under-splitting.
- **Tells** (`policy/tells.yaml`) — high-precision keyword rules with bounded wildcards, exact spans, stable ids, and clause-scoped exclusions; conflicts produce a multi-step plan, never a silent fall-through.
- **Embedding fallback** — planned, not present in V0. Later: local embeddings (bge-m3 via Ollama `/api/embed`), cached exemplars, nearest-exemplar + margin threshold, **abstain** when low.
- **Arbiter** — map need→provider using hard state (project, available tools, graph freshness, turn history). Provider-unavailable ≠ classifier-wrong: record a degraded fallback with a reason; never rewrite the need.

## Hooks
- **UserPromptSubmit** — fire-to-think: classify + decompose + inject the compact verdict *before* action.
- **PreToolUse** — enforce the contract against the next unsatisfied obligation; deny with a corrective instruction. **Turn-scoped**; empty/irrelevant calls satisfy nothing.
- **PostToolUse** — **use receipt**: did the tool return usable, relevant evidence? Invocation alone never advances the contract.

## Learning (later)
"Tool called" is **never** a success label. Only human corrections and machine-verifiable successes update exemplars, via a regression-gated, human-approved, versioned promotion step. No auto-editing of live policy.

## Honesty
v0.1 says **"use receipts,"** not "proof-of-use." No "self-improving" claim until the learning loop ships with real numbers.

## Prior art
Proof-of-Use (arXiv 2510.10931), OATS (2603.13426), ToolACE-MCP (2601.08276), Agent-as-a-Router (2606.22902), aurelio-labs/semantic-router (reference baseline).
