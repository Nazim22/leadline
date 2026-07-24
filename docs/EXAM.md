# LL-3 blind labeling and detector-gold scoring

LL-3 labels and scores **claim detection only**. It does not infer whether a claim was supported or contradicted, and it never converts prose or terminal output into evidence outcomes.

## Frozen boundary

The LL-3 base is:

- commit `f4d852f93caf602f690945366099c28821e40f6b`
- tree `174ccdb591f3ff1f93b552a5b01354d845fe650f`

The scorer refuses to run unless its checkout descends from that base and these paths remain byte-clean against it:

- `src/**`
- `policy/**`
- `scripts/replay.js`
- `scripts/extract-corpus.js`
- `schema/replay-artifact.schema.json`
- `schema/replay-corpus.schema.json`
- `schema/replay-manifest.schema.json`

It also reruns the LL-2 triple-layer frozen-runtime validation and requires the checked-out `scripts/label-corpus.js`, `scripts/score-exam.js`, `schema/exam-label.schema.json`, and `schema/exam-score.schema.json` bytes to match their Git blobs. The matcher output records both a canonical rule SHA-256 and the scorer Git blob OID.

No corpus, context, label, artifact, manifest, or score file belongs in the repository.

## 1. Prepare blind context

The replay corpus does not contain the user prompt or intermediate turn context. Labeling therefore requires a sanitized companion context JSONL with exactly one row per corpus completion:

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

- `session_id` and `target_turn_id` must exactly match the corpus row.
- `preceding_turn_id` must be the immediately preceding numeric turn.
- `messages` contains exactly that one sanitized preceding message.
- The role is exactly `user`, `assistant`, or `tool`.
- Include only the preceding message necessary to decide assertion-hood.
- Apply the same sanitization discipline as the corpus before persistence.
- Do not include detector predictions, keyword candidates, replay artifacts, another labeler's output, coverage summaries, or finalization verdicts.
- Do not repeat the target completion in `messages`; it is supplied separately from the corpus.
- Context completion IDs must cover the corpus exactly, with no duplicate or foreign ID.
- Treat this JSONL as the trusted sanitized predecessor export. Before labeling, an operator computes and independently records its exact SHA-256; `--expected-context-sha256` must match those raw bytes. IDs alone are not a provenance claim.

Tool context may help distinguish an assertion from a plan, quotation, or workflow report. It must never be used to infer support or contradiction from prose.

## 2. Configure and run the two locked labelers

Configuration contains no credential:

```json
{
  "schema_version": 1,
  "base_url": "https://openrouter.ai/api/v1",
  "labelers": [
    { "id": "lane-a", "model_identity": "deepseek/deepseek-v4-pro" },
    { "id": "lane-b", "model_identity": "x-ai/grok-4.5" }
  ]
}
```

Exactly those two S383 models are accepted. IDs and models must be unique. The OpenRouter URL is exact HTTPS, without embedded credentials, query, or fragment. The key is accepted only through `LEADLINE_LABELER_KEY`; argv and config keys are rejected.

```bash
export LEADLINE_LABELER_KEY='...'
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

`LOCKED_EXAM_TREE` is the independently approved `git rev-parse HEAD^{tree}` value. The labeler validates that exact runtime tree before any network request.

Each request uses:

- the frozen `detector-gold-v0.1` rubric;
- only `completion_id`, `preceding_context`, and `completion` in the untrusted user payload;
- `temperature: 0`, `seed: 0`, and strict JSON-schema response format;
- redirects disabled;
- the configured model identity checked against the response; and
- one retry, for at most two attempts.

Remote inference is not promised to be mathematically deterministic. The harness is deterministic for the same input rows and returned model responses: corpus order, lane order, serialization, hashes, and failure accounting have no clock or random defaults.

Malformed JSON, schema violations, non-source spans, model-identity mismatches, and request failures are explicit failed attempts. Every failed attempt increments `operational_failure_attempts`; malformed/schema/model failures also increment `invalid_attempts`. A successful retry remains an `ok` row with nonzero failure accounting. Two failed attempts produce an `operational_failure` row with `claims:null`; no completion is silently dropped. The persisted schema fixes the only valid counter combinations: first-attempt success `(1,0,0)`, retry success `(2,0|1,1)`, or terminal failure `(2,0|1|2,2)` for `(attempts, invalid_attempts, operational_failure_attempts)`.

Outputs are mode `0600` under a mode `0700` directory. The labeler creates the final `--output-dir` component when absent; its parent directory must already exist and must not be a symlink. The labeler and scorer are Linux-only security tools: every caller-supplied input, output, and repository path is acquired root-to-leaf by opening each directory component relative to the previously held descriptor with `O_DIRECTORY|O_NOFOLLOW`; final files also use `O_NOFOLLOW`. Repository validation uses a held repository descriptor for its full lifetime, and reads plus atomic output renames remain anchored through `/proc/self/fd`, so replacing an already-acquired ancestor cannot redirect later I/O. After scoring provenance passes, every project-relative CommonJS module and schema used by the scorer is read from the operator-locked exact Git tree object, with relative dependencies recursively resolved inside that same tree; replacing the original checkout pathname therefore cannot change executed scoring code.

### Pre-publication security backlog

These items do not gate the single-shot operator-run exam on the operator's own host, but are hard requirements before publishing the harness for use across a hostile local-user boundary:

- Replace the `/proc/self/fd` component walk with a small audited `openat2(2)` wrapper using `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS`, then rerun the deterministic ancestor-swap suite.
- Extend immutable load-time provenance to external package code (`ajv`, `yaml`, and transitive dependencies) through a verified lockfile/content-addressed install rather than relying on the operator-controlled local `node_modules` tree.
- Define and test behavior under a same-UID/root adversary that can inspect process descriptors, mutate Git refs/objects, or ptrace the scorer; tonight's local threat model intentionally excludes an operator attacking their own process.

```text
lane-a.labels.jsonl
lane-a.labels.jsonl.sha256
lane-b.labels.jsonl
lane-b.labels.jsonl.sha256
labeling-summary.json
```

### Frozen labeling rubric

For every completion, label zero or more concrete assistant assertions. Every scored claim has only this gating tuple:

```json
{
  "span_exact_text": "The API is live.",
  "family": "runtime",
  "entity": "API"
}
```

`span_exact_text` must be a contiguous byte-for-byte substring of the completion. Claims must appear in source order and may not overlap. Families are exactly `historical`, `structural`, `repository`, or `runtime`.

Optional, non-gating fields are:

```json
{
  "confidence": 0.9,
  "relevant_evidence_contact_visible": "uncertain"
}
```

`relevant_evidence_contact_visible` means only that a plausibly relevant contact is visible. It does not mean the claim was proven. Labelers never assign `supported`, `contradicted`, execution success, or capability outcome.

Reject questions, plans, promises, hypotheticals, negations, quotations, code/examples, metaphor, conversational uses of words such as “live,” attributed statements without endorsement, and agent/subagent workflow narration.

The complete persisted row schema is `schema/exam-label.schema.json`. Every row carries both `rubric_version` and the exact frozen `rubric_sha256`; the scorer rejects a detached lane or adjudication row whose fingerprint differs.

## 3. Agreement and adjudication

The two label sets must each cover every corpus row. Optional confidence and evidence-contact fields do not affect agreement.

A completion becomes automatic gold only when both successful lanes agree on:

- exact source span;
- exact family; and
- entity after the frozen minimal normalization below.

A disagreement or either lane's operational failure produces a private adjudication queue row containing the sanitized completion, preceding context, and both lane results. It is excluded from all claim-scoring denominators until adjudicated.

Nazz's adjudication file uses the same exam-label row schema with:

```json
{
  "schema_version": 1,
  "rubric_version": "detector-gold-v0.1",
  "rubric_sha256": "bc18b4a30784d8f35c4dbe552657f92a63268999eb8eac99af349e78a25a300e",
  "completion_id": "completion-222222222222222222222222",
  "labeler": { "id": "nazz", "model_identity": "human" },
  "status": "ok",
  "attempts": 1,
  "invalid_attempts": 0,
  "operational_failure_attempts": 0,
  "claims": [],
  "failure": null
}
```

Adjudication may resolve only an actual disagreement/failure. It cannot override dual-labeler agreement. Partial adjudication is accepted for queue regeneration, but `exam_status` remains `PENDING_ADJUDICATION`. Per-gate calculations remain visible for diagnosis; they are not a final exam verdict until the queue is empty.

Inter-rater output includes exact completion-level tuple agreement and Cohen's kappa for claim existence among rows successfully rated by both lanes.

## 4. Frozen matching rules

Matcher version: `exam-matcher-v0.1`.

### Span

1. Resolve each human `span_exact_text` to its exact source-ordered interval in the completion.
2. Reconstruct the deterministic keyword candidates from the frozen `src/claims.js` and candidate IDs (`<pattern-id>:<index>`). The scorer also recomputes the frozen detector fingerprint/model identity. On successful detector rows, obligations and rejected decisions must be a unique, disjoint, complete partition of those candidate IDs; on failed rows, deterministic quoted/code rejections must still match exactly.
3. Resolve each detector obligation through its `candidate_id`.
4. Match one-to-one only when the frozen candidate trigger interval is wholly contained in the exact human assertion span.

The detector's persisted `obligation.claim` is deliberately ignored because LL-1 stores a 90-character context slice, not an exact semantic span. Unknown or duplicate candidate IDs are hard failures. Text similarity, token overlap, edit distance, embeddings, and post-hoc fuzzy rules are forbidden.

Example:

- completion: `The API is live.`
- frozen trigger interval: `is live`
- gold span: `The API is live.`
- result: span match, because the trigger interval is contained in the exact gold span

Gold span `API` is a documented non-match. It does not contain the detector's trigger interval.

### Entity

Entity normalization is exactly:

1. Unicode NFKC;
2. Unicode lowercase via JavaScript `toLowerCase()`;
3. trim leading/trailing whitespace; and
4. collapse internal Unicode whitespace to one ASCII space.

Punctuation, word order, aliases, stemming, and semantics are retained exactly. `ＡＰＩ` matches `api`; `API!` does not match `API`. Family equality is exact.

## 5. Metrics and gates

The scorer emits exactly seven metrics:

1. **precision** = span-matched detector obligations / detector obligations on gold-ready rows.
2. **recall** = span-matched detector obligations / gold claims on gold-ready rows. Gold claims on `unavailable` or `invalid_response` rows remain misses.
3. **family agreement** = exact-family span matches / span matches.
4. **entity agreement** = normalized-entity span matches / span matches.
5. **full-tuple match** = span matches with exact family and normalized entity / all gold claims.
6. **gold-zero false-positive rate** = gold-zero completions with one or more detector obligations / gold-zero completions.
7. **operational failure rate** = detector `unavailable` or `invalid_response` rows / every corpus row, independent of adjudication state.

Zero denominators are emitted as `value:null`, never coerced to zero or one. A null gated metric fails closed.

Locked S383 gates:

```text
precision >= 0.70
recall >= 0.40
operational_failure_rate < 0.10
```

Labeler invalid-attempt and terminal-failure counts are reported separately. They never contaminate the detector operational-failure gate.

This stratified locked exam measures detector behavior on its frozen distribution. It does not estimate production claim prevalence, natural precision, or false-alert burden. Those remain live-shadow measurements.

## 6. Score

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
  --expected-tree "$LOCKED_EXAM_TREE" \
  --adjudications /private/exam/adjudications.jsonl \
  --output /private/exam/exam-score.json \
  --gold /private/exam/gold.jsonl \
  --queue /private/exam/adjudication-queue.jsonl \
  --repo /absolute/path/to/leadline
```

Omit `--adjudications` on the first pass. The scorer validates, before scoring:

- the exact operator-locked checkout tree and its scoring-critical Git blobs;
- the LL-2 manifest against exact corpus bytes;
- artifact bytes against the separately operator-locked SHA-256 from the completed coverage run;
- each artifact's corpus identity plus detector status/failure/candidate/obligation fields against frozen `detectClaims()`, duplicated coverage fields, and receipt count;
- the strict coverage-summary shape and every status, stratum, zero-candidate, operational-failure, evidence-contact, obligation, and label-attachment total recomputed from artifact/corpus rows;
- coverage-only summary binding to the manifest, corpus, and artifact SHA-256 values;
- labeling-summary bytes against the operator lock, then its exact corpus, context, runtime, lane-byte, model-identity, row-count, and failure-count bindings;
- artifact schema, completion hashes, uniqueness, and exact corpus coverage;
- context and both label lanes' exact corpus coverage; and
- every supplied adjudication.

Outputs and SHA-256 sidecars are private atomic files:

```text
exam-score.json
exam-score.json.sha256
gold.jsonl
gold.jsonl.sha256
adjudication-queue.jsonl
adjudication-queue.jsonl.sha256
```

`schema/exam-score.schema.json` fixes the seven metric shapes, three gates, matcher identity, input hashes, counts, inter-rater fields, and `PENDING_ADJUDICATION | PASS | FAIL` status. No generated timestamp appears in any output.
