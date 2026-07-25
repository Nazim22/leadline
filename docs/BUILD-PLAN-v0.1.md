<!-- Leadline v0.1 — smallest real version. Private until public launch. -->

# Leadline v0.1 — the smallest real version (claim-enforcement wedge)

> **Thesis (revised S382, Dae + Fable converged):** Leadline is a **vendor-neutral evidence-discipline layer** — it stops coding agents from making important *claims* without fresh, authoritative support, and leaves a replayable audit trail. Routing ("which source") is an **advisory** assist, not the pitch. Time-boxed with a kill-gate; not built ahead of other priorities.

## What v0.1 is (and is not)

**Is:** a claim-obligation detector + evidence receipts + finalization enforcement, wired to Claude Code hooks, dogfooded on Pingu's own agent first.

**Is NOT:** a universal prompt router, a hard gate on ambiguous prompts, an embedding-shortlist dependency, or an open-ended product. The LLM router only *recommends*; it never blocks until held-out precision earns it.

## The five components

### 1. Claim-obligation detector (deterministic, around the CLAIM)
Detect high-risk claims in the agent's output/completion that require evidence — NOT by classifying the user prompt. Seed obligations:
| Claim pattern | Required evidence (authority) | Freshness |
|---|---|---|
| "X is live / deployed / running / up" | runtime probe receipt | fresh |
| "this file/line/code says/does X", "done", "fixed" | current repository read receipt for X | fresh |
| "we decided / shipped / chose X" | historical authority (recall store) receipt | any |
| "these are all callers/deps of X" | structural source w/ completeness semantics | fresh |
Deterministic patterns (like `policy/tells.yaml`, but keyed on claims). High-precision only; unmatched = no obligation.

### 2. Evidence receipts (the durable artifact)
On each tool result (PostToolUse), emit a **claim-support receipt**: `{source, authority_tier, query/args, timestamp, freshness_requirement, result_hash, entity_matched, relevance_determination, claim_or_obligation_supported, policy_decision, failure/override_provenance}`. Append-only, replayable. (Reuse `schema/use-receipt.schema.json`, extended per Dae — rename intent to "evidence-contact / claim-support," never "proof of use.")

### 3. Finalization enforcement (narrow)
At `Stop`/completion: match high-risk claims in the final message against the receipt log. **Block or flag only *unsupported* high-risk claims** — never every ambiguous prompt. Overridable with logged provenance.

### 4. Authority policy (the environment-specific moat)
`policy/authority.yaml`: declares which source is authoritative for which claim-family, conflict precedence, and freshness requirements. This is the part models can't infer and vendors can't commoditize.

### 5. Router as advisory (not a gate)
`UserPromptSubmit` hook runs the LLM classifier → injects a *suggestion* ("looks like runtime → probe live before claiming"). Advisory only. Reuse `src/llm-classifier.js` (after hardening per Dae's 10 blockers).

## Reuse from what's built
- Deterministic pattern engine ← `matcher.js`/`decompose.js` (re-key to claims).
- Receipts ← `satisfaction.js` + `use-receipt.schema.json`.
- LLM advisory ← `llm-classifier.js` (harden first).
- Hooks lifecycle ← Claude Code `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`.

## Dogfood → external proof (the go/no-go)

**Phase A — dogfood on Pingu (user #1).** Wire v0.1 into this Claude Code environment. Measure over real sessions:
- unsupported factual claims caught · wrong-authority claims caught · empty/irrelevant tool calls rejected · **false-block rate** · override/bypass rate · latency + token overhead · **did we keep it enabled voluntarily.**

**Phase B — 3 external teams.** Each configures ≥2 authority classes, runs it on *real* work (not a demo), reports prevented failures they care about, and — the real signal — **keeps it enabled after the trial.**

## Kill-gate (explicit)
- If v0.1's finalization enforcement doesn't catch real unsupported/wrong-authority claims at a tolerable false-block rate on Pingu's own work → **stop, fold machinery into Keel/Pingu, no standalone product.**
- If ≥3 external teams don't keep it enabled after a real trial → **kill the standalone product.**
- If the only thing it can prove is "a tool was called" (not "the claim was backed by the right, fresh authority") → **kill it.**

## Hardening carried from Eval-2 review (Dae's 10 blockers)
Fix before the LLM advisory ships: honest metric denominators · planner verdict-contract compliance · ordered multi-obligation support · model digest-pinning · request timeout · correct chat-model reachability probe · strict response validation · distinguish operational-failure from semantic-abstain · locked prompt/config fingerprint + reproducible receipt · disclose evaluator/labeler/classifier model identities.

## Non-goals for v0.1
No universal routing claims. No hard prompt-classification gate. No embedding shortlist as a prerequisite. No multi-vendor adapters beyond Claude Code until its interception surface is proven here first.
