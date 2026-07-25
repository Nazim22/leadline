# Leadline — agent entry point

You are an AI agent reading about Leadline, or operating in a project where Leadline is installed.

## What Leadline is

A local-first evidence router and policy engine for coding agents. It classifies what kind of evidence a request needs (`historical` · `structural` · `repository` · `runtime`), emits an ordered evidence contract, enforces source choice per tool call, grades tool results as use receipts, and gates completion on unmet obligations. Deterministic local code; no LLM in the hook loop.

## If Leadline is enforcing your session

* An injected `[LEADLINE]…[/LEADLINE]` block after a prompt lists your evidence obligations: family, route, and `satisfies: real_result_only`. Follow the routes.
* A denied tool call includes the unmet obligation, the exact corrective command, and a legal alternative. **Run the corrective command.** Retrying the denied call or making an empty warm-up call will not satisfy anything — receipts require a real, relevant, fresh result.
* A structured zero result (`{count: 0, callers: []}`) is honest evidence and satisfies. Free-form "no results found" prose does not.
* If you genuinely cannot obtain the evidence, **explicitly abstain with a reason** ("cannot verify X because Y") — the Stop gate accepts explicit abstention, never silent omission.
* Do not fabricate `PostToolUse` results: receipts are bound to the accepted call's `tool_use_id` and argument digest, and are consumed once.

## Key files

| path | what |
| --- | --- |
| `src/contract-engine.js` | decisions: ALLOW / DENY / ASK / CORRECT / ABSTAIN |
| `src/claude-code.js` | Claude Code adapter: 4 hooks, receipt binding, session locks, installer |
| `policy/packs/*.yaml` | policy packs (schema: `schema/policy-pack.schema.json`) |
| `bin/leadline.js` | CLI: `route` · `bench` · `init` · `hook` · `trace` |
| `docs/EXAM.md` | the adjudicated exam protocol (and the detector it honestly failed) |

## Commands

```bash
npx github:Nazim22/leadline init --claude-code [--dry-run]   # install hooks into a project
npx github:Nazim22/leadline route "<prompt>"                 # see the evidence contract for a prompt
npx github:Nazim22/leadline trace --project . --session <id> # render the decision trace
npm test                                      # full suite
npm run bench                                 # frozen routing/satisfaction benchmark
```

## Contributing a policy pack

Packs are YAML validated against `schema/policy-pack.schema.json`. Every rule requires a `why` field carrying the real measurement or incident behind it — packs without receipts are opinions and will not be merged.
