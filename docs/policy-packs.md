# Policy-pack authoring

Policy packs turn an evidence preference into an enforceable route with a reason, sanctioned fallback, receipt requirement, and expiry.

Shipped packs live in `policy/packs/`. `leadline init --claude-code` copies them to `.leadline/packs/`; when that project directory exists, it replaces the package pack directory as the runtime source.

The machine contract is [`schema/policy-pack.schema.json`](../schema/policy-pack.schema.json). Runtime validation is intentionally strict: unknown fields, missing fields, duplicate rule IDs, empty arrays, invalid regular expressions, and unsupported capabilities fail loading.

## Minimal pack

```yaml
schema_version: "1.0"
id: structural-before-search
version: "1.0.0"
description: Require code-graph callers before raw repository search.
required_capabilities:
  - inject_before_action
  - intercept_tool_call
  - deny_tool_call
  - inspect_tool_result
  - block_completion
rules:
  - id: callers-before-grep
    trigger:
      when_family: structural
      obligation_patterns:
        - "\\b(?:callers of|who calls)\\b"
      attempted_families: [repository, unknown]
      tool_names: [Read, Grep, Glob, Bash, Agent]
    required_family: structural
    preferred_route: mcp__gbrain__code_callers
    sanctioned_fallback: Grep/Read after declaring the graph unavailable or stale
    satisfies: real_result_only
    denial_template:
      unmet: "Structural evidence for {subject} is still unmet. Why: {why}"
      corrective: "Run {preferred_route} for {subject}."
      alternative: "Use {sanctioned_fallback} or explicitly abstain with a reason."
    why: "measured burn: raw search repeatedly re-derived indexed caller facts"
    ttl: 86400
```

## Top-level fields

| field | contract |
| --- | --- |
| `schema_version` | exactly `"1.0"` |
| `id` | lowercase kebab-case |
| `version` | `MAJOR.MINOR.PATCH` numeric form |
| `description` | non-empty string |
| `required_capabilities` | unique, non-empty capability list |
| `rules` | non-empty rule list |

Allowed capabilities:

- `inject_before_action`
- `intercept_tool_call`
- `deny_tool_call`
- `request_human_approval`
- `inspect_tool_result`
- `block_completion`

The current loader validates capability names but does not independently filter packs by the active adapter. Ship a pack only where the host mode can honor its required behavior.

## Rule fields

Every rule requires every field below; there are no optional rule keys.

| field | meaning |
| --- | --- |
| `id` | stable non-empty rule identity, unique within the pack |
| `trigger` | selects a planned family or a protected tool operation |
| `required_family` | `historical`, `structural`, `repository`, or `runtime` |
| `preferred_route` | exact corrective provider/tool route |
| `sanctioned_fallback` | legal alternative shown to the agent |
| `satisfies` | exactly `real_result_only` |
| `denial_template` | exactly `unmet`, `corrective`, and `alternative` |
| `why` | the burn receipt: measured failure or concrete reason for the gate |
| `ttl` | satisfaction lifetime in seconds; `0` means no expiry |

Denial templates support four substitutions:

- `{subject}` — relevance subject from the current obligation;
- `{why}` — the rule’s burn receipt;
- `{preferred_route}` — corrective route; and
- `{sanctioned_fallback}` — legal alternative.

The three template fields are joined in that order with newlines. Keep each field to one line to preserve the three-part denial grammar.

## Trigger forms

A trigger must use one of two forms.

### Planned-family rule

```yaml
trigger:
  when_family: structural
  obligation_patterns: ["\\bwho calls\\b"]
  attempted_families: [repository, unknown]
  tool_names: [Read, Grep, Bash]
```

- `when_family` matches the current evidence obligation.
- `obligation_patterns` optionally narrows the obligation question. Patterns compile as Unicode, case-insensitive regular expressions.
- `attempted_families` selects wrong-source families to correct.
- `tool_names` optionally narrows attempted tools and matches case-insensitively.

### Protected-operation rule

```yaml
trigger:
  tool_names: [Bash]
  input_patterns:
    - "(?:terraform|tofu)\\s+apply"
```

This form requires both `tool_names` and `input_patterns`. Input patterns run against the JSON-serialized tool arguments as Unicode, case-insensitive regular expressions.

After one protected-operation denial, repeating the same operation can escalate to `ASK`. Approval binds to the exact provider, operation name, canonical arguments, and call ID for one invocation; it does not grant a session-wide bypass.

## Preferred-route matching

Provider/tool routes match case-insensitively by full provider name, operation name, or MCP-style provider suffix.

`Read <path>` is deliberately stricter:

- `Read` operation identity is case-insensitive;
- the configured path and supplied `file_path`/`path` must be literal byte-equal;
- suffixes, case variants, backslashes, and normalized aliases such as `symlink/../file` do not satisfy it.

## Real-result receipts

Invocation is never satisfaction. A result must be:

1. non-empty and substantive;
2. relevant to the obligation subject; and
3. fresh when the rule TTL requires freshness.

Transport metadata, argument echoes, and generic negative prose do not establish source contact.

### Structured zero convention

Legitimate negative results must be structured and subject-bearing:

```json
{"symbol":"applyDiscount","count":0,"callers":[]}
```

This is accepted because the subject establishes relevance and the numeric zero establishes an explicit negative result. These are rejected:

```text
No callers found for applyDiscount.
```

```json
{"count":0,"callers":[]}
```

The first is unauthenticated prose. The second has a zero but no subject to bind it to the obligation.

## Authoring checklist

- Use a stable pack ID and rule IDs.
- Name the actual authoritative route, not a generic aspiration.
- Put the concrete burn in `why`; do not write “best practice.”
- Give a real sanctioned fallback or explicit human-approval route.
- Keep denials to exactly three useful lines.
- Use `real_result_only` and test empty, irrelevant, stale, structured-zero, and realistic-positive receipts.
- Test that a wrong source is denied and the preferred source is silent-allowed.
- For protected operations, test exact-path impostors and one-invocation approval binding.
- Run `npm test`; pack schema and runtime validation are covered by the suite.
