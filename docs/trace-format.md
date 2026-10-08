# Decision trace format

Leadline writes one JSON object per line to:

```text
.leadline/traces/<session-id>.jsonl
```

The format is append-only and intentionally small. Every row has exactly six top-level keys in this order:

```json
{
  "obligation": "Who calls applyDiscount?",
  "family": "structural",
  "attempted": "Grep",
  "verdict": "DENY",
  "corrected_route": "mcp__gbrain__code_callers",
  "receipt": {
    "rule_id": "callers-before-raw-search",
    "pack_id": "code-intelligence-before-raw-search",
    "why": "wrong-source reflex: …",
    "gaming_attempt": false
  }
}
```

## Top-level fields

| field | type | meaning |
| --- | --- | --- |
| `obligation` | string | evidence question or synthetic prerequisite being decided |
| `family` | string | `historical`, `structural`, `repository`, `runtime`, or `unknown` for binding failures |
| `attempted` | string or `null` | provider/tool identity, if a tool was attempted |
| `verdict` | string | `ALLOW`, `DENY`, `ASK`, `CORRECT`, or `ABSTAIN` |
| `corrected_route` | string or `null` | route the agent should use next |
| `receipt` | object or `null` | decision-specific evidence and failure metadata |

A trace is an audit record, not a stable database API. The six top-level fields are fixed by runtime code; receipt keys vary by decision type.

## Verdicts

| verdict | meaning |
| --- | --- |
| `ALLOW` | the attempted path may proceed, or a receipt satisfied an obligation |
| `DENY` | enforce mode blocked the path or completion |
| `ASK` | request human approval for the exact protected operation |
| `CORRECT` | provide corrective context; may block a bad PostToolUse receipt in enforce mode or stay advisory |
| `ABSTAIN` | the agent explicitly declined verification and supplied a reason |

Verdict alone does not tell you whether the host was blocked. For example, an enforce-mode PostToolUse receipt failure is traced as `CORRECT` while the Claude adapter returns `{decision:"block"}`. Interpret the trace as policy history and the adapter response as host control flow.

## Common receipt fields

Receipt objects are deliberately contextual. Current fields include:

| field | meaning |
| --- | --- |
| `rule_id`, `pack_id`, `why` | policy provenance |
| `satisfied` | whether this row satisfied an obligation or prerequisite |
| `failure` | `empty`, `irrelevant`, `stale`, `wrong_source`, or `unbound_tool_result` |
| `correction_followed` | a previously denied corrective route produced this receipt |
| `gaming_attempt` | a wrong-source result attempted to satisfy another family |
| `call_id` | unbound PostToolUse call ID, when available |
| `human_approval_requested` | protected operation escalated to `ASK` |
| `human_approval_followed` | the exact approved operation returned |
| `anti_lockup_downgrade` | completion was allowed after two Stop denials without satisfying the obligation |
| `stop_denials` | count for the current unmet obligation |
| `reason` | explicit abstention text |

## Renderer

Render one session from the project directory:

```bash
node ./bin/leadline.js trace --session <id>
```

Use `--project <dir>` when reading another project:

```bash
node ./bin/leadline.js trace --project /path/to/project --session <id>
```

Example:

```text
Leadline session — denials: 1; corrections followed: 1; abstentions: 0; gaming attempts caught: 0
1. Who calls applyDiscount? [structural] Grep DENY -> mcp__gbrain__code_callers
2. Who calls applyDiscount? [structural] mcp__gbrain__code_callers ALLOW
```

The header counts:

- rows whose verdict is `DENY`;
- rows with `receipt.correction_followed === true`;
- rows whose verdict is `ABSTAIN`; and
- rows with `receipt.gaming_attempt === true`.

## Storage behavior

- Session IDs matching `[A-Za-z0-9_.-]+` become filenames directly.
- Other IDs are replaced by a deterministic SHA-256-derived safe filename.
- Trace files are created/appended with mode `0600`.
- `.leadline/.gitignore` excludes `state/` and `traces/` from the project repository.
- Leadline does not transmit traces or add timestamps to trace rows.

Treat traces as potentially sensitive: they contain obligation text, tool identities, routes, and abstention reasons. Keep them local unless you have reviewed and sanitized them.
