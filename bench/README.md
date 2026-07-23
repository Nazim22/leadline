# Leadline benchmark

A small, honest, reproducible benchmark. It exists before enforcement does — measurement first.

## Two corpora, kept separate (benchmark discipline)
- **`dev-corpus.jsonl`** — tuning set. Iterate tells against this.
- **`eval-corpus.jsonl`** — **frozen** evaluation set. Never tune against it; never silently edit a gold label — version any correction. Tuning against eval = reporting memorization as routing quality.

Each routing case: `{id, prompt, gold_route[], kind}`. `gold_route` is the ordered list of evidence families (`[]` = should abstain).

## Satisfaction / gate-gaming cases — `satisfaction-cases.jsonl`
Routing accuracy is not the anti-gaming claim. These cases pair a step's `satisfaction` criteria with a `simulated_result` and the `expected {satisfied, failure}`. They prove the honest part: an **empty or irrelevant tool call does NOT satisfy an obligation** (`sat-empty-gaming`, `sat-irrelevant`, `sat-ritual-emptyargs`), stale evidence fails when freshness is required (`sat-stale`), and relevant evidence satisfies (`sat-relevant`). This is what makes the gate-gaming metric implementable without a live agent.

## Conditions compared
1. prose instruction only
2. existing deny-only gate
3. Leadline route recommendation, no enforcement
4. Leadline route + enforcement + use receipts

Also compare a plain embedding nearest-route **for classification only** — not graded on enforcement it doesn't claim.

## Metrics reported (all of them, including misses; sample size labeled prominently)
- first-evidence-route accuracy over cases whose gold plan is non-empty (`N routed` is printed separately; correct abstentions do not inflate it)
- full ordered-plan exact-match over all cases (a non-empty route with `complete=false` is a miss; correct empty-route abstentions still count)
- gate-gaming bypass rate over expected `empty`/`irrelevant` failures only
- freshness rejection rate over expected `stale` failures
- false-block rate over cases expected to satisfy
- abstention rate over all cases
- multi-intent family recall
- routing latency

## Run
`npm run bench`

The runner executes both corpora separately, prints `N` prominently, lists every miss, and then runs the satisfaction simulation. It deliberately does not tune against or rewrite `eval-corpus.jsonl`.
