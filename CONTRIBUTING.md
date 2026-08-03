# Contributing to Leadline

Thanks for considering it. Leadline's whole identity is *claims with receipts* — the contribution rules exist to keep that true.

## The fast loop

```bash
npm test          # full suite — must be green before any PR
npm run bench     # frozen routing/satisfaction benchmark — run it if you touched routing, tells, or satisfaction
```

There is no hidden CI magic yet: the suite you run locally is the gate. If you change routing behavior, paste the before/after bench output in the PR description.

**Platform note (honest).** The router, matcher, planner, receipts, and Claude Code hooks run on any Node ≥18 platform, and so does `npm run bench`. The corpus labeling harness (`scripts/label-corpus.js`) requires **Linux** — it uses `/proc/self/fd` with `O_NOFOLLOW` for race-safe I/O and fails with `race-safe exam I/O requires Linux /proc/self/fd and O_NOFOLLOW` elsewhere; `extract-corpus.js` degrades gracefully via `(O_NOFOLLOW || 0)`. Some replay and provenance tests also exercise symlink-rejection paths, which need symlink-creation rights (e.g. Windows Developer Mode). If you're on a non-Linux host, expect `scripts/label-corpus.js` to error while the core router suites and `npm run bench` stay green — that's a harness constraint, not a regression you introduced.

## What goes where

* **Quick fixes** (typo, doc bug, obvious regression) → straight to a PR.
* **Policy packs** → PR welcome any time, one rule: **every rule must carry a `why` field with the real measurement or incident behind it.** "Agents shouldn't do X" is an opinion; "our audit found N wasted calls per session doing X" is a receipt. Packs without receipts are not merged. Validate against `schema/policy-pack.schema.json` before submitting.
* **Anything touching the contract engine, the Claude Code adapter, receipt semantics, lock behavior, schemas, or the security boundary** → **open an issue first** and get a design discussion. These surfaces survived an adversarial review gauntlet before launch; changes to them get the same treatment.
* **Exam machinery** (`scripts/label-corpus.js`, `scripts/adjudicate-union.js`, `scripts/score-exam.js`, `docs/EXAM.md`) → the exam protocol is versioned and its history is part of this project's credibility. Any change to gold construction, matching, or scoring rules requires a protocol version bump, and results are only ever valid on a **fresh held-out slice** — no post-hoc rescoring of old data, ever. Read `docs/EXAM.md` before proposing anything here.

## House rules for claims

* **No unverifiable claims in docs or messages.** If the README says a number, a reproduce command sits next to it. If a denial template asserts a reason, the rule's `why` carries the receipt. PRs that add absolute claims ("always", "every", "guaranteed") without proof will be asked to soften or substantiate.
* **Denial messages follow the grammar**: (1) the unmet obligation, (2) the exact corrective command, (3) the legal alternative — ≤3 lines, deterministic per rule-id, no moralizing. See any shipped pack's `denial_template` for the shape.
* **Fail-mode discipline**: enforcement paths fail *closed*, advisory paths fail *open*. A change that lets a crashed hook silently disable enforcement — or lets a dry run block anyone — is a correctness bug regardless of what else it improves.

## Review & attribution

* Every PR is reviewed against the exact commits (we review git objects, not descriptions).
* AI-assisted contributions are welcome — this project was built by AI agents under adversarial review. Keep attribution honest via `Co-Authored-By:` trailers.
* Contributors are credited in release notes for every accepted change.

## Tests are part of the change

Non-trivial logic lands with the test that would catch its regression. The adversarial pattern we use ourselves: write the RED test that reproduces the defect first, then the fix, then keep both.
