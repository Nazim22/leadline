<!-- Leadline — private until public launch. Do not distribute. -->

# Leadline

*Your agent asks the wrong tool, or fakes the right one. Leadline stops both.*

**Evidence control plane for coding agents** · routes each question to the right source · enforces the evidence path · records use receipts · local-first · no embeddings required for V0

> Pronounced **"LED-line"** — a nautical lead line sounds unseen depth and brings back a seabed sample. It routes to ground truth *and* returns proof contact happened.

---

Coding agents pick tools by willpower. They trust stale context, and they fake tool calls to satisfy gates — a published failure mode: **tool-call hacking**. Deny-only gates say "not that path"; they never say "here's the right one," and they can be gamed.

Leadline classifies what kind of evidence a request needs — **history, code structure, repository bytes, or live runtime** — routes the agent to the authoritative source, blocks evidence-path bypasses, and records whether the tool produced *usable* evidence. Unlike a semantic router, it doesn't merely *select* a tool; it **enforces and audits the evidence path.**

## Before / after

You ask: *"did we build the retry logic, and is it live?"*

Without Leadline, the agent spawns a code-scout to re-derive what your knowledge base already knows, then greps for deploy state.

With Leadline:
```
Need: historical → runtime
  1. historical  → recall store   (what was built)
  2. runtime     → live probe     (is it deployed)
Do not scout or grep for documented build-state.
```

## What it does

- **Decompose** a request into ordered evidence obligations (`historical → runtime`, `structural → repository`, …) — routes aren't mutually exclusive.
- **Route** each obligation to an evidence family, mapped to *your* tools via adapters.
- **Enforce** on the agent's hook lifecycle — the wrong tool for the current obligation is blocked with a *corrective* instruction. Turn-scoped, never a session-wide unlock.
- **Record use receipts** — did the tool return usable, relevant evidence? An empty or irrelevant call **never** advances the contract. This is the anti-gaming guarantee.

## How it works

```
  your prompt
      │
      ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Leadline   (runs locally — deterministic core, no LLM)   │
  │  ──────────────────────────────────────────────────────  │
  │  decompose → tells → [embeddings*] → arbiter → contract   │
  │                                                          │
  │  4 evidence families → your provider adapters:           │
  │    historical → recall store     structural → code graph │
  │    repository → grep/read/git    runtime    → live probe │
  └──────────────────────────────────────────────────────────┘
      │  ordered route contract  +  use receipts
      ▼
  agent acts on the right source — and proves it used it
        (*embeddings = V3, not shipped yet)
```

- **Decompose** — split conjunctive asks deterministically; prefer under-splitting.
- **Tells** — high-precision keyword rules with word boundaries, stable ids, clause-scoped negation; conflicts produce a multi-step plan, never a silent fall-through.
- **Arbiter** — map need→provider using hard state (project, available tools, graph freshness). Provider-unavailable ≠ classifier-wrong — it records a degraded fallback with a reason.
- **Receipts** — `empty → irrelevant → stale → satisfied`, in that order. Only a satisfied receipt advances the contract or feeds learning.

## Benchmark — the honest state

Leadline is measurement-first: the benchmark exists **before** enforcement does. Reproduce everything with one command:

```bash
npm install && npm run bench
```

**Current results — a synthetic, self-labeled corpus (N=26). This is a scaffold baseline, NOT proof on real work.**

| Corpus | N | first-route | exact-plan | multi-intent |
| --- | --- | --- | --- | --- |
| Development (tuning) | 8 | 100% | 100% | 100% |
| **Frozen evaluation** | 18 | **72.2%** | **66.7%** | 50% |

The frozen eval is never tuned against — it honestly exposes 6 Stage-1 tell gaps (that's the *point* of a frozen set; it names the next work).

**Anti-gate-gaming — simulated (N=7):**

| Ritual call | Satisfies the need? |
| --- | --- |
| empty result | **NO** |
| irrelevant non-empty result | **NO** |
| empty-args invocation | **NO** |
| stale result (when freshness required) | **NO** |

0/5 bypasses. This is the core guarantee — verified in `satisfaction.js`, against fixtures.

### What "real" testing means (not done yet — the roadmap is honest about it)

The numbers above come from prompts *we* wrote and labeled. The tests that actually matter, following how modern tools benchmark (a real agent doing real work), are:

1. **Real corpus** — hundreds of prompts harvested from real transcripts, labeled independently of whoever tuned the tells.
2. **Live shadow run** — wire the `UserPromptSubmit` hook in a real session, log the router's verdict vs. the tool the agent *actually* reached for. No enforcement — pure measurement against reality.
3. **Live gate-gaming test** — fire an empty tool call in a real session; confirm enforcement + the receipt block it.

Until those land, the honest claim is: *a verified scaffold with a synthetic baseline* — not *it works on your real work.*

## Install

`v0.0.1` — **pre-alpha, private. Not yet installable.** The intended UX:
```bash
npx leadline init     # scaffolds hooks + a provider manifest for your stack
```

## Compared to

| | routes | enforces the path | proves the source was used | local | deps for core |
| --- | --- | --- | --- | --- | --- |
| **Leadline** | ordered evidence plan | yes (turn-scoped) | **yes — use receipts** | yes | none |
| semantic-router | single label | no | no | yes (with local encoder) | encoder + vector store |
| deny-only gates | — | blocks wrong path | no (gameable) | yes | none |

semantic-router is a fine classifier and a useful baseline; it selects a tool. Leadline enforces and audits the evidence path — a different job.

## Design
Full design + external review (Daedalus) in [`docs/DESIGN.md`](docs/DESIGN.md).

## License
MIT — see [`LICENSE`](LICENSE).
