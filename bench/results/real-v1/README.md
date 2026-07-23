# Real frozen benchmark — Dae blind lane (`real-v1`)

## Provenance

- Raw corpus commit: `f32da3c8c494dafebc3a91a5c1ec3422e8958238`
- Frozen router commit: `3b1977ed5b280dcc2daa60963eb0e6b50f474899`
- Frozen rubric commit: `864672ac6e9b930c6783e7445e42db3468f4ebb3`
- Label-seal commit: `79dec7fbfd0cd9b27c74ce9c08decc06b7ecc650`
- Corpus size: 250 prompts; 250 distinct IDs and clusters
- Raw source fields were mechanically verified unchanged in the labeled artifact.
- No tell or router changes were made after the router freeze.

## Source and sampling

The source was 367 top-level Claude Code session transcripts from 2026-06-23 through 2026-07-21, all pre-Leadline; subagents and the current session were excluded. Extraction retained genuine human plain-string user turns only and excluded tool results, hook/meta injections, slash commands, programmatic review-agent briefs, and Leadline mentions. Exact duplicates were removed after text normalization. From 705 unique prompts, the corpus took an even-stride sample over the time-sorted list, capped at 250; it was not keyword-selected. All 250 rows have distinct cluster IDs. Secrets were scrubbed before delivery; the producer reported a zero-finding post-scrub audit after manually clearing one benign URL false-positive.

## Blind labeling

Three disjoint Dae shards labeled the raw prompts under frozen rubric `real-v1` without access to policy or predictions. A separate blind consistency audit reviewed all 250 rows and proposed nine corrections. Seven uncontested corrections were applied. Four ambiguous prompts were independently relabeled from prompt text and rubric alone; those tie-break decisions were applied. The labels and adjudication log were committed before the first router execution.

Final gold first-family distribution:

| First family | Rows |
|---|---:|
| Abstain | 165 |
| Historical | 50 |
| Runtime | 23 |
| Repository | 11 |
| Structural | 1 |

Confidence: 214 high, 28 medium, 8 low. Context dependency: 88 none, 112 project, 40 referent, 10 both.

## Frozen baseline

| Metric | Result |
|---|---:|
| First-route accuracy, routed gold only | 1/85 (1.2%) |
| Full-plan exact match, all rows | 166/250 (66.4%) |
| Full-plan exact match, routed gold only | 1/85 (1.2%) |
| Gold-abstention recall | 165/165 (100.0%) |
| Predicted abstention rate | 248/250 (99.2%) |
| Multi-intent family recall | 1/23 across 11 cases (4.3%) |

The all-row 66.4% exact-match headline is dominated by correct abstentions and must not be presented as routed quality. The router emitted a route for only two prompts: `real-000204` was exactly correct; `real-000030` predicted runtime but missed the leading historical obligation.

First-route confusion pairs:

| Gold | Predicted | Count |
|---|---|---:|
| Historical | Abstain | 48 |
| Runtime | Abstain | 23 |
| Repository | Abstain | 11 |
| Historical | Runtime | 1 |
| Structural | Abstain | 1 |

## Artifacts

- `dae-report.json` — metrics, distribution, confusion pairs, and complete miss objects.
- `dae-misses.jsonl` — complete honest miss list (84 rows).
- `dae-predictions.jsonl` — all 250 gold/prediction pairs.
- `../../real-prompts-dae-labeled.jsonl` — sealed Dae labels.
- `../../real-prompts-dae-adjudication.jsonl` — versioned audit/tie-break changes.

No policy tuning was performed against this corpus. Inter-rater agreement with the separately produced second blind lane is intentionally pending until that lane is delivered.
