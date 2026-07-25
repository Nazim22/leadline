# Stage-2 offline replay (`replay-v0.1`)

LL-2 builds corpus extraction and deterministic, coverage-only replay around the frozen LL-1 object. It does **not** implement aggregate scoring or live hooks.

## Hard boundary

The replay definition is frozen at:

- Commit: `8488cb333157208e9781f8d3c32ea0dda587a368`
- Tree: `1a3bd1de77558ecebf92ef4bed4a9d7bd1dfaca9`
- Capability map `cap-v0.2`
  - SHA-256: `7d6e892a79b2745c1f8158d9717f2a6a29acfc42841c25b262a3b74451fbf3c5`
  - Git blob: `ec73261eca1585edfa3ffaac43d40548a0cbe00d`
- Contact normalizer `contact-normalizer-v0.3`
  - SHA-256: `7d6e892a79b2745c1f8158d9717f2a6a29acfc42841c25b262a3b74451fbf3c5`
  - Git blob: `ec73261eca1585edfa3ffaac43d40548a0cbe00d`
- Entity matcher `entmatch-v0.2`
  - SHA-256: `2cbba3bf1a0366d641a2ba8b65fd564fa0c41428ed5f726cd9180251e1bf2366`
  - Git blob: `bd9f752986d5076d257e388426763bee78e26868`
- Authority policy `authority-v0.3`
  - Canonical SHA-256: `4316cc2d3023c1d4e3331f3e3e326c90af74d4de0b251c6a3032cf5889610fd7`
  - Git blob: `f5339a75219b067c9d49de840f7d1634e3a84007`
- Overrides: `{}`

Manifest generation and replay validate those identities before doing work. The harness branch may add scripts, schemas, tests, and documentation, but `src/**` and `policy/**` must remain byte-identical to the frozen definition.

## 1. Extract and sanitize a corpus

Run this only on the transcript-owning host:

```bash
node scripts/extract-corpus.js \
  --transcripts /absolute/path/to/claude/projects \
  --output /absolute/path/to/frozen-corpus.jsonl \
  --seed 'explicit-frozen-seed-v1' \
  --quotas 'keyword_positive=50,keyword_negative=50,quotes_code=25,subagent_process=25'
```

The extractor writes:

- `frozen-corpus.jsonl`, mode `0600`;
- `frozen-corpus.jsonl.sha256`, the SHA-256 of the exact JSONL bytes; and
- a one-line result on stdout containing the row count, output path, and corpus hash.

There is no clock or random default. `--seed` and all four quotas are mandatory. If a requested stratum has fewer eligible completions than its quota, extraction fails rather than silently changing the sample.

### Selection contract

1. Recursively enumerate input `.jsonl` files in locale-independent UTF-8 byte order.
2. Reconstruct human turns and accumulate tool calls/results within each turn.
3. Consider final assistant messages: an assistant event must contain non-empty text and no `tool_use` block; a later `tool_use` in the same turn invalidates the pending text unless another final text event follows it.
4. Build the complete candidate pool before selection. Do not pre-filter to keyword matches.
5. Assign every completion to exactly one of `keyword_positive` or `keyword_negative`; independently add `quotes_code` and/or `subagent_process` when applicable.
6. For each stratum, rank candidates by SHA-256 of `(seed, stratum, completion_id)`, select its quota, then union and deduplicate overlapping selections.
7. Sort persisted rows by `completion_id`.

Because strata overlap, final row count can be less than the sum of quotas. A completion selected by two strata remains one denominator row carrying both stratum tags.

### Sanitization contract

Sanitization occurs in memory before any output is written:

- completion text, tool arguments, result values, and explicit errors are recursively passed through the frozen `redactSecrets` implementation;
- source paths and source session identifiers are not persisted; seeded SHA-256 pseudonyms become `session_id`, `completion_id`, and `tool_call_id`;
- transcript parse failures are skipped without copying the rejected line anywhere;
- assistant completions without a valid transcript timestamp are excluded rather than assigned a clock-derived timestamp.

The transcript owner remains responsible for reviewing the sanitized corpus before moving or committing it. The frozen redactor protects credential forms; it is not a general-purpose PII anonymizer.

The output must be outside the transcript directory. Corpus, checksum, manifest, artifact, and summary writes use private same-directory temporary files followed by atomic rename; existing output symlinks and input/output path collisions are rejected.

### Corpus schema

`schema/replay-corpus.schema.json` records the exact row shape:

```json
{
  "schema_version": 1,
  "completion_id": "completion-<seeded hash>",
  "session_id": "session-<seeded hash>",
  "turn_id": "turn-7",
  "completed_at": "2026-07-24T02:00:00.000Z",
  "completion": "The tests passed.",
  "strata": ["keyword_positive"],
  "tool_calls": [
    {
      "tool_call_id": "tool-<seeded hash>",
      "provider": "bash",
      "name": "bash",
      "args": { "command": "npm test" },
      "result": {
        "value": "136 tests passed",
        "error": null,
        "exit_code": 0,
        "is_error": false,
        "http_status": null,
        "executed_test_count": 136,
        "observed_at": "2026-07-24T01:59:59.000Z",
        "truncated": false
      }
    }
  ]
}
```

All result keys are present; unavailable fields are `null`. The extractor copies only structured transcript fields. It recognizes snake_case and their direct camelCase aliases, such as `exit_code`/`exitCode`. It never parses free-form tool output to infer `exit_code`, `http_status`, or `executed_test_count`. Event timestamps may supply `observed_at`.

`args` must remain present because the frozen capability map needs the operation/command to derive authority. Evidence receipts produced by replay retain only the frozen argument hash.

## 2. Generate the provenance manifest

Unlabeled coverage corpus:

```bash
node scripts/replay.js manifest \
  --corpus /absolute/path/to/frozen-corpus.jsonl \
  --output /absolute/path/to/provenance.json \
  --label-set-id unlabeled \
  --repo /absolute/path/to/leadline
```

If a blind labels file has later been frozen, add both:

```text
--labels /absolute/path/to/labels.jsonl --label-set-id <frozen-label-set-id>
```

Labels are opaque to LL-2. Corpus `completion_id` values must be unique; duplicates are rejected during both manifest generation and replay validation. Every non-empty label row must be JSON containing a unique `completion_id`, and a replay with labels requires exact one-to-one coverage of corpus completion IDs. LL-2 preserves each entire label row in the corresponding artifact but does not interpret it or compute metrics.

The manifest schema is `schema/replay-manifest.schema.json`. The manifest pins the frozen component list above, exact corpus bytes, label-set identity/hash/count, `replay-v0.1`, mode `coverage`, and `overrides:{}`. It intentionally contains no generated timestamp.

## 3. Run offline replay

Start the digest-pinned Qwen model in local Ollama, then run:

```bash
node scripts/replay.js run \
  --corpus /absolute/path/to/frozen-corpus.jsonl \
  --manifest /absolute/path/to/provenance.json \
  --config /absolute/path/to/leadline/policy/claim-detector.json \
  --policy /absolute/path/to/leadline/policy/authority.yaml \
  --output /absolute/path/to/per-completion-artifacts.jsonl \
  --summary /absolute/path/to/coverage-summary.json \
  --repo /absolute/path/to/leadline
```

Add `--labels FILE` only when the manifest already pins the exact file hash. Corpus and labels hashes are validated before detector creation. A corpus mismatch fails with `corpus sha256 mismatch`.

The CLI calls `createConfiguredClaimDetector` directly from the frozen detector module; no `src/index.js` export change is needed. Before any frozen module is loaded, every `src/**` and `policy/**` byte is checked against commit `8488cb3`. The supplied authority-policy and detector-config files are opened without following symlinks, checked once, and copied into a private temporary directory; those immutable copies are the files subsequently loaded. Only credential-free HTTP(S) localhost Ollama URLs are accepted (`localhost`, `127.0.0.1`, or `::1`), every fetch destination is revalidated, and redirects are disabled. All corpus, repository, policy, config, and output paths are explicit arguments.

For every sampled completion, replay:

1. reconstructs evidence-contact receipts from that turn's sanitized tool calls using the frozen normalizer;
2. calls the configured claim detector;
3. calls `evaluateFinalization` with the completion timestamp and `overrides:{}`;
4. emits one schema-validated artifact row; and
5. retains detector failures, invalid responses, zero-candidate completions, keyword-positive and keyword-negative strata, tool contacts, detector obligations, and any opaque label record.

The artifact schema is `schema/replay-artifact.schema.json`. Completion text is bound by `completion_sha256`; the sanitized text remains in the separately hashed corpus.

The summary contains coverage and operational counts only:

- sampled completions and stratum counts;
- detector status counts (`ok`, `unavailable`, `invalid_response`);
- zero-candidate completions;
- operational-failure completions;
- evidence-contact and obligation counts; and
- manifest, corpus, and artifact hashes.

It contains no precision, recall, F-score, pass/fail gate, or other scored aggregate. The mode remains `coverage` even when opaque labels are attached.

## Blind scoring gates

A scored run remains blocked until Nazz freezes both:

1. the independent gold-labeler decision; and
2. the kill-gate thresholds.

LL-2 provides no scoring code path. Any later scoring implementation must treat every corpus completion as a denominator and preserve raw gold rows so detector-unavailable/invalid, zero-candidate, and gold-missed cases cannot disappear. Changes to the frozen components, corpus construction, labels, or scoring rules require a new held-out slice.

## Verification

```bash
node scripts/replay.js --help
node scripts/extract-corpus.js --help
node --test test/replay.test.js
npm test
```

The unit fixtures cover seeded extraction/redaction, stale intermediate-completion rejection, a deterministic three-completion replay, opaque-label retention and validation, coverage-only output, operational failures, zero candidates, private no-follow outputs, localhost redirect enforcement, schema validation, and corpus-hash rejection.
