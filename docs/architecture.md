# Architecture

Leadline is a deterministic evidence router and policy engine. The shipped runtime integrates with Claude Code through four hooks and persists an evidence contract, accepted-call bindings, use receipts, and decision traces per session.

## Runtime loop

```text
User prompt
    │
    ▼
UserPromptSubmit ──▶ planner ──▶ ordered evidence contract
    │                                │
    │                                ├─ complete
    │                                ├─ steps[]
    │                                └─ unmatched_clauses[]
    ▼
PreToolUse ────────▶ policy engine ─▶ ALLOW | DENY | ASK | CORRECT
    │
    ▼
PostToolUse ───────▶ binding check ─▶ receipt grading
    │                                empty → irrelevant → stale → satisfied
    ▼
Stop ──────────────▶ completion gate
                                     met → allow
                                     unmet → deny twice
                                     third attempt → warn and allow
                                     reasoned abstention → allow as ABSTAIN
```

The adapter entry point is `bin/leadline.js`. The runtime implementation is split between:

- `src/planner.js` — prompt decomposition and ordered route contracts;
- `src/contract-engine.js` — pack loading, policy decisions, receipt grading, completion gating, and trace rendering;
- `src/claude-code.js` — Claude Code hook translation, state locking, atomic persistence, hook installation, and CLI trace reads;
- `policy/tells.yaml` and `policy/routes.yaml` — package-level deterministic route configuration;
- `policy/packs/*.yaml` — shipped policy packs; and
- `schema/*.schema.json` — policy and adapter contracts.

## Evidence contract

`UserPromptSubmit` calls the planner and stores the resulting contract in session state. The injected block contains:

- contract ID;
- `complete: true|false`;
- unmatched clause indexes and text;
- up to four ordered obligations; and
- each obligation’s family, route, and `real_result_only` requirement.

If the planner emits no obligations, the hook is silent. An unresolved positive clause remains visible through `complete: false` and `unmatched_clauses`; partial routing is not represented as complete.

The four families are:

| family | evidence question |
| --- | --- |
| `historical` | what was decided, built, shipped, or documented? |
| `structural` | what calls, imports, references, or depends on what? |
| `repository` | what exact bytes, code, or configuration exist? |
| `runtime` | what is alive, deployed, or responding now? |

## Claude Code hook semantics

| hook | input role | success shape | corrective / blocking shape |
| --- | --- | --- | --- |
| `UserPromptSubmit` | begin a turn and inject the contract | `{}` when unrouted; otherwise `hookSpecificOutput.additionalContext` | process failure follows configured mode |
| `PreToolUse` | enforce the current route or protected-operation prerequisite | `{}` for silent allow | `permissionDecision: "deny"`, `permissionDecision: "ask"`, or non-blocking `additionalContext` in advisory mode |
| `PostToolUse` | bind and grade the returned result | `{}` for a satisfied receipt | `{decision:"block", reason}` in enforce mode; non-blocking `additionalContext` in advisory mode |
| `Stop` | gate completion while an obligation remains | `{}` when met or after a reasoned abstention | block twice; third attempt returns a visible `systemMessage` and allows completion |

### Receipt binding

A PostToolUse result is accepted only when it matches a PreToolUse call accepted in the current turn. The binding contains:

- `tool_use_id`;
- current turn ID;
- exact tool identity; and
- SHA-256 of canonicalized arguments.

A successful match is consumed once. A missing, mismatched, or replayed binding is rejected as `unbound_tool_result`.

### Receipt grading

The engine grades an accepted result in this order:

```text
empty → irrelevant → stale → satisfied
```

The substance check ignores transport metadata and exact input echoes. Free-form negative prose such as `No results found` does not count because it cannot distinguish an honest source response from a fabricated sentence. A structured zero must carry both the queried subject and an explicit zero field, for example:

```json
{"symbol":"applyDiscount","count":0,"callers":[]}
```

The subject binds relevance; `count: 0` makes the negative outcome explicit.

### Stop anti-lockup

An unmet obligation blocks the first two Stop attempts. The third attempt returns a visible warning and allows completion. This is an escape hatch, not satisfaction: the trace records `anti_lockup_downgrade: true` and the obligation remains unmet.

A completion that explicitly says it must abstain or cannot verify, and includes a reason (`because`, `reason`, or `due to`), returns `ABSTAIN` without blocking.

## State and trace files

Project installation creates:

```text
.claude/settings.json       # merged hook registrations
.leadline/config.yaml       # adapter + enforce/advisory mode
.leadline/packs/*.yaml      # copied project policy packs
.leadline/state/<id>.json   # per-session contract and enforcement state
.leadline/traces/<id>.jsonl # append-only decision rows
.leadline/.gitignore        # ignores state/ and traces/
```

Session IDs outside `[A-Za-z0-9_.-]` are replaced by a deterministic SHA-256-derived filename. State writes use a temporary mode-`0600` file followed by atomic rename. Trace appends use mode `0600`.

A per-session directory lock serializes hook processes. Locks carry a random owner token; stale-lock recovery uses a separate reaper lock, and release deletes only a lock still owned by that token. This prevents an expired owner from deleting a replacement owner’s lock.

## Modes

Two related mode systems exist and should not be conflated.

### Runtime configuration

`.leadline/config.yaml` accepts:

- `enforce` — deny/block decisions are binding; unexpected hook failures exit with Claude Code’s blocking status `2`;
- `advisory` — the same decisions become non-blocking corrective context; unexpected hook failures log to stderr, emit `{}`, and exit `0`.

`--dry-run` installs `advisory` mode. It does not skip the engine; it runs the same routing and grading path without blocking.

### Adapter capabilities

`schema/adapter-capabilities.schema.json` defines six booleans. Capability negotiation computes the strongest safe host mode:

| mode | minimum capability shape |
| --- | --- |
| `ENFORCE` | inject + intercept + deny + inspect result + block completion |
| `PARTIAL_ENFORCE` | intercept + deny |
| `ADVISE` | inject or intercept |
| `AUDIT` | neither injection nor interception |

Claude Code declares all six capabilities and is the only shipped adapter. Other-host adapters are roadmap work.

## Installation behavior

`leadline init --claude-code`:

1. preserves unrelated Claude settings and hook entries;
2. removes only previously managed Leadline commands for each event;
3. appends one current Leadline command per event;
4. copies shipped packs into `.leadline/packs/`; and
5. writes mode and adapter configuration.

The operation is idempotent. Project-local packs override the package pack directory as a set. Route and tell files currently remain package-fixed; per-project route/tell configuration is not shipped.

## Trust boundary

The hook loop imports no network or process-execution client. It reads local policy, state, hook input, and tool output. Leadline decides whether evidence contact occurred; it does not make the authoritative query itself.

The repository also contains historical evaluation and detector tooling with separate model/network paths. Those tools are not loaded by the Claude Code hook runtime.
