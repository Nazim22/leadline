# Real-corpus blind labeling rubric — `real-v1`

Frozen before any annotator opens `real-prompts-unlabeled.jsonl`.

## Objective

Label the ordered authoritative evidence families explicitly requested by each user utterance. Label the user's evidence need, not the tool named, not the route the current policy is likely to predict, and not every prerequisite an agent might choose while implementing.

The only valid family values are:

- `historical`
- `structural`
- `repository`
- `runtime`

Use `[]` when there is no in-scope evidence request.

## Families

### `historical`

Prior decisions, conversations, rationale, completed work, past ship/build/deploy events, or past incident state. This asks what was known or true in project history.

Examples: what we decided; why an approach was chosen; what was built last session; whether something shipped previously; what happened during an incident.

Do not use it merely because a sentence is past tense. Exact Git/file content at an old commit is `repository`. Static call relationships are `structural`.

### `structural`

Static code-graph relationships or symbol location: callers, callees, imports, references, dependencies, definition sites, inheritance, and impact/blast-radius relationships.

Examples: who calls `chargeCard`; what imports a module; where a symbol is defined; what depends on a schema.

A request for the exact implementation/body/line is `repository`, not `structural`.

### `repository`

Exact source-controlled or workspace bytes and byte-derived inspection: file content, code body, config value, line, diff, commit content, Git status, exact text search, code/diff review, or verifying what the implementation currently says.

Examples: show the exact function body; inspect this diff; what does line 40 say; compare two config files; review the current implementation for a bug.

A request only for relationships or definition location is `structural`.

### `runtime`

Current observed state that requires a live probe: deployed version, service/process health, port availability, current database/system state, current logs or metrics, current CI/test result, or whether a live endpoint responds.

Examples: is production live; what is listening on port 443; did the just-run test pass; what is the current DB row count.

Past incident state is `historical` unless exact retained log bytes are explicitly requested.

## Decomposition and ordering

1. Split only distinct evidence-bearing clauses or commands.
2. Preserve the user's textual order.
3. Emit one family per distinct obligation.
4. Preserve repeated families when they are separate obligations: `structural(alpha) → repository(config) → structural(beta)` labels as `["structural","repository","structural"]`.
5. Duplicate cues for the same subject/obligation produce one family.
6. A negated request contributes no route. Other positive work in the same sentence remains labelable.
7. When a comparison explicitly requires two sources, include both in the order implied by the request.

## Abstention (`[]`)

Use `[]` for:

- direct build/fix/write/refactor/deploy/run commands with no explicit evidence or verification subrequest;
- opinion, brainstorming, design, prioritization, or general explanation;
- acknowledgements and conversational control;
- general web/product/documentation knowledge outside these four project evidence sources;
- an utterance too ambiguous to justify any family.

Do not add `repository` merely because implementation would normally require reading code. A direct command such as “clean up this function” is `[]`. An inspection request such as “review this function for the bug” is `repository`.

## Edge rules

- Label the evidence family even when its target is unresolved. “Is it live?” is `["runtime"]`; target resolution is a separate planner metric.
- Label explicit evidence needs only. Mixed action + evidence prompts include the evidence clauses and omit action-only clauses.
- Current Git/worktree facts are `repository`; prior team/session decisions are `historical`.
- Exact old-commit bytes/diffs are `repository`; a narrative of what the team changed or why is `historical`.
- Symbol references/callers/imports are `structural`; raw string occurrence or exact source text is `repository`.
- Current infrastructure, process, endpoint, database, logs, metrics, tests, or CI observations are `runtime`.
- Naming a provider does not determine the label. Infer the underlying evidence need.

## Annotation fields

Each labeled row preserves the four raw fields and adds:

```json
{
  "gold_route": ["historical", "runtime"],
  "label_confidence": "high",
  "context_dependency": "none",
  "label_note": "",
  "rubric_version": "real-v1",
  "labeler": "dae"
}
```

Allowed `label_confidence`: `high`, `medium`, `low`.

Allowed `context_dependency`:

- `none` — route and target class are understandable from the utterance;
- `referent` — family is inferable but a pronoun/deictic target needs prior turns;
- `project` — family is inferable but project/environment scope needs prior turns;
- `both` — both referent and project scope depend on prior turns.

Confidence measures ambiguity in the gold route, not expected router performance. `label_note` is empty unless needed to explain a medium/low-confidence choice.

## Blindness and change control

- Annotators must not inspect `policy/tells.yaml`, run the router, inspect predictions, or read router misses before sealing labels.
- Raw row order and content remain unchanged.
- Labels are committed before any benchmark run.
- Any later correction is a versioned adjudication with a reason. Pre-adjudication metrics remain reportable.
- No tell or router changes are permitted against this frozen corpus. Router commit: `3b1977ed5b280dcc2daa60963eb0e6b50f474899`.
