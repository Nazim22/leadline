# LL-4 blind detector-gold exam v2

LL-4 labels and scores **claim detection only**. It does not infer whether a claim was supported or contradicted, and it never converts prose or terminal output into evidence outcomes.

Implementation base:

- commit `c8cbd77255244276c5efb4682332333ca5d969a7`
- tree `698e39cd9faf87e9531347e5307a3963e3049d62`

The inherited LL-3 detector/replay base remains frozen. The v2 labeler, adjudicator, scorer, and all three exam schemas are runtime-provenance paths. Labeling records every path's Git blob. Scoring requires the identical path set, exact pre-label causal blobs, and a sealed adjudication artifact bound to the exact commit, tree, and blob map. Scorer/adjudicator-only bytes may differ from the earlier labeling runtime only where the causal-boundary allowlist explicitly permits them.

### Historical replay and extraction runtime generations

Historical replay provenance is immutable. `scripts/replay.js` keeps commit `8488cb333157208e9781f8d3c32ea0dda587a368` and tree `1a3bd1de77558ecebf92ef4bed4a9d7bd1dfaca9` as its frozen identity, and loads project modules directly from that Git tree. Changed checkout bytes are never reported under the historical manifest. The three replay schemas, which are not present in that historical tree, are loaded from the immutable Git blobs pinned in `FROZEN_SCHEMAS`; replay never compiles mutable checkout schema bytes.

Future corpus extraction uses the separate `extraction-runtime-v2` causal manifest in `scripts/extract-corpus.js`. Its complete transitive local CommonJS closure is pinned by both Git blob and SHA-256:

| Path | Git blob | SHA-256 |
|---|---|---|
| `src/capability.js` | `41160296cf91fe6c97293da8247c19653367c5bb` | `40a110a3c120c298b398de477fb63d147a5aa2d8f64e5d0cd986d15ffd5f09a7` |
| `src/claims.js` | `3aa8352239a81c45850a7b9dca9a4a153274728f` | `fba5fa3719704caf6065640503cffb9e9e549fd32fbac7eac974be35abdb737e` |
| `src/entity-match.js` | `bd9f752986d5076d257e388426763bee78e26868` | `af0a211393e94c8f3abff612b5421f71c1b5d08d92818e9b1fb514c7cd27efdd` |
| `src/evidence.js` | `22a60c1df5f82644c470138f7ac50c0ea13b1acf` | `3334559a118c1714183687a88aebc42998ee26dd7c5870f73036299c615d04c7` |
| `src/receipts.js` | `ec509af77e3182eefad7678287c799ec2d849b67` | `dff3f1b020b493356984ee5b1d4acdeb8f48dbfdaceba9f7a2d1ba50babab60d` |

Comparability is guaranteed only within one extraction-runtime generation. Cross-generation analysis requires re-extraction under one common generation or an explicit methodological qualification. The LL-6 security fix creates v2 because `src/capability.js` changed inside the loaded closure; the bounded whitespace change in `src/decompose.js` is outside that closure. Neither change regenerates or mutates a sealed historical artifact.

No corpus, context, label, artifact, manifest, adjudication, or score file belongs in the repository. All execution artifacts are private operator-side files.

## 0. Launch conditions

Build-side conditions 1–3 are enforced by code and tests:

1. exact-tree and Git-blob runtime provenance;
2. frozen model request/response identities with strict OpenRouter routing and no fallback;
3. strict schemas, deterministic protocol/matcher hashes, complete corpus coverage, explicit failure accounting, and sealed-artifact-only scoring.

Launch condition 4 is intentionally operator-executed because OpenRouter key custody remains on LXC 122. **Before any paid lane run, Pingu runs the real Kimi synthetic preflight from 122 as execution step zero against the merged, operator-locked tree.** LXC 134 never receives the credential. A failed preflight stops the exam; it is not replaced by a mocked or inferred success.

The first real preflight stopped the exam before corpus extraction because Kimi's sole endpoint does not support `temperature` or `seed`, and OpenRouter returns its generic model slug rather than the dated endpoint name. Protocol `exam-v2.1` incorporated those observed constraints before any slice was drawn or scored.

The second preflight also stopped before corpus extraction. Moonshot rejected JSON Schema properties without explicit `type`, while Google AI Studio ignored `const` for `schema_version`. Protocol `exam-v2.2` explicitly types every outbound response-schema property and constrains `schema_version` redundantly as integer `const:2`, `minimum:2`, and `maximum:2`. The persisted exam artifact schemas remain the strict Ajv contracts; these redundant outbound constraints are provider-compatibility guards and do not change response semantics.

## 1. Blind context

The sanitized companion context JSONL has exactly one row per corpus completion:

```json
{
  "schema_version": 1,
  "completion_id": "completion-111111111111111111111111",
  "session_id": "session-aaaaaaaaaaaaaaaaaaaaaaaa",
  "target_turn_id": "turn-1",
  "preceding_turn_id": "turn-0",
  "messages": [
    { "role": "user", "content": "Is the API deployed and healthy?" }
  ]
}
```

Contract:

- IDs and session/turn identity match the corpus exactly.
- `preceding_turn_id` is the immediately preceding numeric turn.
- `messages` contains only the sanitized preceding message needed to decide assertion-hood.
- The target completion is not repeated in context.
- Detector predictions, candidates, artifacts, other lane output, coverage, votes, and verdicts are forbidden.
- The operator independently locks the exact context-file SHA-256 before labeling.

## 2. Concurrent frozen lanes

Credential-free configuration:

```json
{
  "schema_version": 2,
  "base_url": "https://openrouter.ai/api/v1",
  "labelers": [
    {
      "id": "lane-a",
      "request_model": "x-ai/grok-4.5",
      "model_identity": "x-ai/grok-4.5",
      "request_profile": "deterministic-v1"
    },
    {
      "id": "lane-b",
      "request_model": "moonshotai/kimi-k3-20260715",
      "model_identity": "moonshotai/kimi-k3",
      "request_profile": "provider-default-v1"
    }
  ]
}
```

Exactly those lane mappings are accepted. Both lanes start concurrently and independently. Every request uses:

- frozen rubric `detector-gold-v0.2` and its exact SHA-256;
- only `completion_id`, sanitized preceding context, and completion text;
- strict JSON Schema for both lanes;
- profile `deterministic-v1` (`temperature:0`, `seed:0`) for Grok;
- profile `provider-default-v1` (both sampling fields omitted) for Kimi because its sole endpoint does not support either field; this lane therefore uses provider-default sampling;
- `provider.require_parameters: true` and `provider.allow_fallbacks: false`;
- no OpenRouter `models` fallback list;
- exact returned model-identity validation;
- redirects disabled; and
- one retry, for at most two attempts.

Run after launch-condition step zero:

```bash
export LEADLINE_LABELER_KEY='operator-held value'
CONTEXT_SHA256=$(sha256sum /private/exam/context.jsonl | cut -d' ' -f1)
mkdir -m 700 /private/exam/labels
node scripts/label-corpus.js \
  --corpus /private/exam/corpus.jsonl \
  --context /private/exam/context.jsonl \
  --expected-context-sha256 "$CONTEXT_SHA256" \
  --config /private/exam/labelers.json \
  --output-dir /private/exam/labels \
  --repo /absolute/path/to/leadline \
  --expected-tree "$LOCKED_EXAM_TREE"
```

`LOCKED_EXAM_TREE` is the independently approved `git rev-parse HEAD^{tree}`. Runtime validation completes before the first network request.

Malformed JSON, schema violations, non-source spans, model mismatches, and transport failures are explicit failed attempts. No completion is dropped. Two failed attempts produce `status:"operational_failure"`, `claims:null`, and exact counters. Output rows record both the request model and verified response identity.

### Pre-publication security backlog

These items do not gate the single-shot operator-run exam on the operator's own host, but are hard requirements before publishing the harness for use across a hostile local-user boundary:

- Replace the `/proc/self/fd` component walk with a small audited `openat2(2)` wrapper using `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS`, then rerun the deterministic ancestor-swap suite.
- Extend immutable load-time provenance to external package code (`ajv`, `yaml`, and transitive dependencies) through a verified lockfile/content-addressed install rather than relying on the operator-controlled local `node_modules` tree.
- Define and test behavior under a same-UID/root adversary that can inspect process descriptors, mutate Git refs/objects, or ptrace the scorer; tonight's local threat model intentionally excludes an operator attacking their own process.

### Frozen labeling rubric

A scored claim is only:

```json
{
  "span_exact_text": "The API is live.",
  "family": "runtime",
  "entity": "API"
}
```

The span is a contiguous exact substring. Claims are source-ordered and non-overlapping. Families are `historical`, `structural`, `repository`, or `runtime`. Optional confidence and evidence-contact visibility fields never affect voting or scoring. Labelers never assign support, contradiction, execution success, or capability outcome.

Reject questions, plans, promises, hypotheticals, negations, quotations, code/examples, metaphor, conversational keyword uses, attributed statements without endorsement, and agent/subagent workflow narration.

## 3. Deterministic union and candidate adjudication

The lane outputs are not compared as whole completions and are never replaced wholesale by a third label.

For each completion:

1. Resolve every lane claim to its exact source interval.
2. Cluster only claims with the same family, NFKC/lowercase/whitespace-normalized entity, and pairwise exact interval containment. Mere overlap does not merge.
3. Derive opaque candidate IDs and seeded order from frozen seed `leadline-exam-v2-union-seed-20260724`.
4. Preserve each lane's candidate vote. A successful lane that omitted a candidate votes `reject`; a failed lane votes `operational_failure`.
5. Send Gemini only the sanitized completion/context and one opaque candidate. It never receives lane identity, lane output, agreement state, detector data, or another vote.
6. Accept or reject a candidate only with at least two matching votes among Grok, Kimi, and Gemini. Otherwise it remains `abstain` and the artifact is pending.

Run:

```bash
node scripts/adjudicate-union.js \
  --corpus /private/exam/corpus.jsonl \
  --context /private/exam/context.jsonl \
  --lane-a /private/exam/labels/lane-a.labels.jsonl \
  --lane-b /private/exam/labels/lane-b.labels.jsonl \
  --labeling-summary /private/exam/labels/labeling-summary.json \
  --expected-labeling-summary-sha256 "$LOCKED_LABELING_SUMMARY_SHA256" \
  --output /private/exam/exam-adjudication.json \
  --repo /absolute/path/to/leadline \
  --expected-tree "$LOCKED_EXAM_TREE"
```

The adjudicator is pinned to `google/gemini-3.6-flash`; lane identities remain Grok 4.5 and Kimi K3. Gemini and Grok use `deterministic-v1`. Kimi uses `provider-default-v1` for both initial labeling and completeness-sweep validation. All adjudication requests retain strict JSON Schema, no-fallback routing, and exact response-identity checks.

## 4. All-completion completeness sweep

Gemini receives one blind completeness-sweep request for **every** completion, including lane-agreement and zero-claim rows. It proposes only claims absent from the deterministic lane union.

Each valid sweep-only proposal is then independently and blindly validated by Grok and Kimi. It becomes a candidate under the same two-of-three rule. A sweep failure, invalid proposal, or undecidable vote is explicit and leaves the artifact `PENDING_ADJUDICATION`; it cannot silently certify completeness.

The sealed `exam-adjudication.schema.json` artifact binds:

- protocol version and canonical protocol SHA-256;
- rubric version/SHA-256 and deterministic seed;
- all request and response identities;
- exact exam schema SHA-256 values;
- exact producing commit, tree, and runtime blob map;
- exact corpus, context, both lane-file, and labeling-summary SHA-256 values;
- per-completion candidates, lane votes, three-way votes, decisions, sweep status, and accepted gold claims;
- explicit invalid-response attempts, operational-failure attempts, and failed-request count; and
- terminal status `COMPLETE` or `PENDING_ADJUDICATION`.

## 5. Frozen matcher, metrics, and gates

Matcher version remains `exam-matcher-v0.1`:

- A detector candidate matches one-to-one only when its frozen trigger interval is wholly contained in the exact accepted gold span.
- Family equality is exact.
- Entity normalization is Unicode NFKC, lowercase, trim, then collapse Unicode whitespace to one ASCII space. Punctuation, aliases, word order, stemming, and semantics are not normalized.
- Unknown/duplicate candidate IDs or incomplete detector partitions are hard failures.

Seven metrics remain frozen:

1. precision;
2. recall;
3. family agreement;
4. entity agreement;
5. full-tuple match;
6. gold-zero false-positive rate; and
7. detector operational-failure rate.

Zero denominators emit `value:null`; null gated metrics fail closed. Gates:

```text
precision >= 0.70
recall >= 0.40
operational_failure_rate < 0.10
```

Inter-rater exact completion agreement and claim-existence Cohen's kappa are emitted as `inter_rater_diagnostic` with `gating:false`. They never decide gold or gate the exam.

## 6. Single scoring pass

```bash
node scripts/score-exam.js \
  --corpus /private/exam/corpus.jsonl \
  --context /private/exam/context.jsonl \
  --artifacts /private/exam/replay-artifacts.jsonl \
  --expected-artifact-sha256 "$LOCKED_ARTIFACT_SHA256" \
  --manifest /private/exam/provenance.json \
  --coverage-summary /private/exam/coverage-summary.json \
  --lane-a /private/exam/labels/lane-a.labels.jsonl \
  --lane-b /private/exam/labels/lane-b.labels.jsonl \
  --labeling-summary /private/exam/labels/labeling-summary.json \
  --expected-labeling-summary-sha256 "$LOCKED_LABELING_SUMMARY_SHA256" \
  --adjudication /private/exam/exam-adjudication.json \
  --expected-adjudication-sha256 "$LOCKED_ADJUDICATION_SHA256" \
  --expected-tree "$LOCKED_EXAM_TREE" \
  --output /private/exam/exam-score.json \
  --gold /private/exam/gold.jsonl \
  --queue /private/exam/adjudication-queue.jsonl \
  --repo /absolute/path/to/leadline
```

The scorer rejects v1 whole-completion adjudication arrays. It accepts only the sealed v2 artifact, recomputes protocol/schema/runtime bindings, candidate decisions, accepted gold claims, source spans, corpus coverage, replay coverage, and every frozen input hash before scoring.

Final status is:

- `PENDING_ADJUDICATION` when any candidate/sweep remains unresolved;
- `PASS` only when adjudication is complete and all three gates pass; or
- `FAIL` when adjudication is complete and any gate fails.

Private atomic outputs and SHA-256 sidecars:

```text
exam-score.json
exam-score.json.sha256
gold.jsonl
gold.jsonl.sha256
adjudication-queue.jsonl
adjudication-queue.jsonl.sha256
```

No generated timestamp appears in deterministic protocol, adjudication, or score output. This locked stratified exam measures detector behavior on its frozen distribution; production prevalence and false-alert burden still require live shadow.
