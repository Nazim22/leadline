<!-- Leadline — private until public launch. Do not distribute. -->

# Leadline

**Sound the source. Bring back proof.**

An **evidence control plane for coding agents.** Leadline classifies what kind of evidence a request needs — history, code structure, repository bytes, or live runtime state — routes the agent to the authoritative source, blocks evidence-path bypasses, and records whether the tool produced usable evidence.

Unlike a semantic router, Leadline does not merely *select* a tool; it **enforces and audits the evidence path.**

> Pronounced **"LED-line"** — a nautical lead line sounds unseen depth and brings back a seabed sample: it routes to ground truth *and* returns proof contact happened.

## The problem
Coding agents pick tools by willpower. They trust stale context, and they fake tool calls to satisfy gates (a published failure mode: *tool-call hacking*). Deny-only gates say "not that path" — never "here's the right path," and can be gamed.

## What Leadline does
1. **Decompose** a request into ordered evidence obligations (`historical → runtime`, `structural → repository`, …).
2. **Route** each obligation to an evidence family, mapped to your tools via adapters:
   - `historical` → knowledge/recall store
   - `structural` → code graph
   - `repository` → grep / read / git
   - `runtime` → live probe (CLI / API / health)
3. **Enforce** on the agent's hook lifecycle — the wrong tool for the current obligation is blocked with a *corrective* instruction. Turn-scoped, never a session-wide unlock. Empty/irrelevant calls satisfy nothing.
4. **Record use receipts** — did the tool return usable, relevant evidence? A mere invocation never advances the contract.

## Status
`v0.0.1` — **pre-alpha, private.** V0 measurement engine is runnable: deterministic decomposition, high-precision tells, ordered route contracts, frozen evaluation, and offline satisfaction simulation. **No enforcement or embeddings ship yet.** Not for distribution.

## Run
```bash
npm install
npm test
npm run bench
node ./bin/leadline.js route "did we ship the graph fix, and is it live?"
```

`route` prints the Evidence Route Contract as JSON. `bench` scores the tuning and frozen corpora separately, prints every miss, and verifies that empty, irrelevant, ritual, or stale results do not satisfy an evidence need.

## Design
See [`docs/DESIGN.md`](docs/DESIGN.md). Architecture reviewed externally (Daedalus, 2026-07-22).

## License
MIT — see [`LICENSE`](LICENSE).
