# Leadline benchmark

A small, honest, reproducible benchmark. It exists before enforcement does — measurement first.

## Corpus
`corpus.jsonl` — sanitized real prompts, each labeled with a **gold ordered route** (`[]` = should abstain). Grown from real transcripts. Includes the two motivating failure traces (`fail-001` build-state re-derive, `fail-002` gate-gaming), paraphrases, multi-intent, negation, and abstain cases. **Sample size is labeled prominently in every result** — no hiding a tiny N.

## Conditions compared
1. prose instruction only
2. existing deny-only gate
3. Leadline route recommendation, no enforcement
4. Leadline route + enforcement + use receipts

Also compare a plain embedding nearest-route **for classification only** — not graded on enforcement it doesn't claim.

## Metrics reported (all of them, including misses)
- first-evidence-route accuracy
- full ordered-plan exact-match
- bypass success rate (the gate-gaming number)
- false-block rate
- abstention rate
- unnecessary tool calls
- routing latency

## Run
`(runner is V0 work — not yet implemented)`
