# Leadline agent guide

Leadline is a deterministic evidence router and policy engine for coding agents. It routes evidence obligations, enforces policy packs through Claude Code hooks, grades real tool results, and blocks unsupported completion claims.

## Read first

- [`README.md`](README.md) — product contract, current capabilities, setup, and honest benchmark
- [`docs/architecture.md`](docs/architecture.md) — runtime loop, hook semantics, state, modes, and trust boundary
- [`docs/policy-packs.md`](docs/policy-packs.md) — pack authoring and structured-zero convention
- [`docs/trace-format.md`](docs/trace-format.md) — JSONL decision records
- [`docs/EXAM.md`](docs/EXAM.md) — frozen detector-exam methodology; preserve as historical protocol

## Repository map

```text
bin/leadline.js          CLI
src/planner.js           deterministic route planning
src/contract-engine.js   policy decisions, receipt grading, Stop gate
src/claude-code.js       Claude Code adapter and installer
policy/tells.yaml        package-fixed routing tells
policy/routes.yaml       package-fixed family/provider routes
policy/packs/            shipped policy packs
schema/                  JSON Schema contracts
bench/                   frozen and development fixtures
test/                    Node test suite
```

## Commands

```bash
npm install
npm test
npm run bench
node ./bin/leadline.js --help
node ./bin/leadline.js route "Who calls applyDiscount?"
```

For a disposable Claude Code integration smoke:

```bash
project=$(mktemp -d)
node ./bin/leadline.js init --claude-code --project "$project" --dry-run
```

## Invariants

- The hook loop remains local and deterministic: no LLM, network, telemetry, or child-process path.
- Invocation never satisfies an obligation; only a bound, substantive, relevant, fresh-enough result can.
- PostToolUse binds to an accepted PreToolUse call in the current turn and is consumed once.
- Free-form negative prose does not satisfy. Use a subject-bearing structured zero such as `{"symbol":"x","count":0,"callers":[]}`.
- Enforce failures fail closed; advisory failures log and fail open.
- Stop blocks twice, then visibly warns and allows without marking the obligation satisfied.
- Preserve unrelated Claude Code hooks and settings during installation.
- Project packs may replace shipped packs. Route and tell configuration remains package-fixed in this release.
- `docs/EXAM.md` is a frozen historical protocol. Do not rewrite it as current hook behavior.

## Change discipline

- Keep diffs acceptance-scoped; do not revive the detector as a completion gate.
- Add focused tests for changed behavior before implementation changes.
- Run one full `npm test` after the diff is stable.
- If a README or docs claim names a command, execute that exact command.
- If a benchmark number changes, update its denominator and reproduce command together.
- Do not commit generated traces, session state, private corpora, model outputs, exam artifacts, or credentials.
