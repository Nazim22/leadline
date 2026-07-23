<!-- Leadline — private until public launch. Do not distribute. -->

# Leadline

*Your agent asks the wrong tool, or fakes the right one. Leadline measures both failure modes before enforcement ships.*

**Evidence control plane for coding agents** · routes each question to the right source · emits ordered evidence contracts · evaluates use receipts offline · local-first · no embeddings required for V0

> Pronounced **"LED-line"** — a nautical lead line sounds unseen depth and brings back a seabed sample. It routes to ground truth *and* returns evidence that contact happened.

---

Coding agents pick tools by willpower. They trust stale context, and they can fake tool calls to satisfy gates — a published failure mode: **tool-call hacking**. Deny-only gates say "not that path"; they never say "here's the right one," and they can be gamed.

Leadline classifies what kind of evidence a request needs — **history, code structure, repository bytes, or live runtime** — and emits an ordered contract pointing at the authoritative source. V0 measures route quality and use-receipt satisfaction. **Hook enforcement and live receipt capture are not shipped yet.**

## Before / after

You ask: *"did we build the retry logic, and is it live?"*

Without Leadline, the agent may spawn a code scout to re-derive what your knowledge base already knows, then grep for deploy state.

With Leadline V0:
```
Need: historical → runtime
  1. historical  → recall store   (what was built)
  2. runtime     → live probe     (is it deployed)
Contract complete: true
```

If any positive clause cannot be routed or lacks a relevance anchor, the contract says `complete: false` and lists it in `unmatched_clauses`; partial classification cannot look successful.

## What it does today

- **Decompose** a request into ordered evidence obligations (`historical → runtime`, `structural → repository`, …) — routes are not mutually exclusive.
- **Route** each obligation to an evidence family, mapped to *your* tools via adapters.
- **Fail closed on classification gaps** — repeated same-family obligations are preserved, unresolved targets abstain, and unmatched clauses are explicit.
- **Evaluate use-receipt criteria offline** — empty, irrelevant, or stale simulated results do not satisfy an obligation.

Planned, not shipped in V0: host hooks, enforcement, provider availability arbitration, live use-receipt capture, embeddings, and adaptation.

## How it works

```
  your prompt
      │
      ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Leadline V0   (local deterministic core, no LLM)         │
  │  ──────────────────────────────────────────────────────  │
  │  decompose → high-precision tells → ordered contract      │
  │                                                          │
  │  4 evidence families → provider mappings:                 │
  │    historical → recall store     structural → code graph │
  │    repository → grep/read/git    runtime    → live probe │
  └──────────────────────────────────────────────────────────┘
      │
      ├── route contract (`complete`, steps, unmatched clauses)
      └── offline use-receipt satisfaction simulation
```

- **Decompose** — split explicit sequencing and high-precision conjunction boundaries; prefer under-splitting.
- **Tells** — bounded wildcard rules with exact spans, stable IDs, and span-scoped negation. Conflicts produce ordered multi-step plans.
- **Targets** — every emitted step has a non-empty relevance anchor; unresolved targets abstain.
- **Receipts** — evaluation order is `empty → irrelevant → stale → satisfied`. Invocation alone never counts.

## Benchmark — the honest state

Leadline is measurement-first: the benchmark exists **before** enforcement does. Reproduce it with:

```bash
npm install && npm run bench
```

**Current results — synthetic, self-labeled corpora (N=26). This is a scaffold baseline, NOT proof on real work.**

| Corpus | N | first-route | exact-plan | multi-intent |
| --- | ---: | ---: | ---: | ---: |
| Development (tuning) | 8 | 100.0% | 100.0% | 100.0% |
| **Frozen evaluation** | 18 | **62.5%** | **61.1%** | 50.0% |

First-route accuracy excludes gold-abstention cases and prints its routed-case denominator. A non-empty predicted route with `complete=false` cannot receive exact-plan credit. Correct empty-route abstentions still count.

The frozen evaluation corpus is never tuned against. It currently exposes **7 Stage-1 misses**; the runner prints every miss and any unmatched clauses.

**Anti-gate-gaming — simulated (N=7):**

| Metric | Result |
| --- | ---: |
| empty/irrelevant gate-gaming bypasses | **0/4** |
| stale evidence rejected when freshness is required | **1/1** |
| false blocks on expected-success cases | **0/2** |

These are deterministic fixture results from `src/satisfaction.js`, not live-agent evidence.

### What real testing means — not done yet

The numbers above come from prompts we wrote and labeled. The tests that matter next are:

1. **Real corpus** — prompts harvested from real transcripts and labeled independently of whoever tunes the tells.
2. **Live shadow run** — wire a host adapter into real sessions and compare Leadline's contract with the sources the agent actually uses. No enforcement first.
3. **Live gate-gaming test** — after enforcement exists, fire empty, irrelevant, and stale calls in a real session and verify they cannot advance the contract.

Until those land, the honest claim is: *a verified measurement scaffold with a synthetic baseline* — not *it works on your real work.*

## Run from source

`v0.0.1` — **pre-alpha, private.** The repository is runnable; there is no public package release or hook installer yet.

```bash
npm install
npm test
npm run bench
node ./bin/leadline.js route "did we ship the graph fix, and is it live?"
```

The intended later UX is `npx leadline init`, after host adapters and enforcement ship.

## Compared to

| Current capability | ordered routes | enforces the path | validates source use | local |
| --- | ---: | ---: | ---: | ---: |
| **Leadline V0** | **yes** | no — planned | offline simulation | yes |
| semantic-router | single label | no | no | yes with a local encoder |
| deny-only gates | — | blocks selected paths | no; invocation may be gameable | yes |

`semantic-router` is a useful classification baseline; it selects a tool. Leadline's intended product scope is an ordered, enforceable, auditable evidence path, but V0 ships only the measurement layer.

## Design

Full design and external review notes are in [`docs/DESIGN.md`](docs/DESIGN.md).

## License

MIT — see [`LICENSE`](LICENSE).
