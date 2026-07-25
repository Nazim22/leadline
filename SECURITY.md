# Security Policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository (Security tab → "Report a vulnerability"). Reports are read by the maintainer; you'll get an acknowledgment and a disposition. Please don't open public issues for exploitable problems.

## Threat model — stated honestly

Leadline is a **local-first tool running on the operator's own machine with the operator's own privileges**. Within that model it defends seriously:

* Wrong-source and gate-gaming defenses assume the *agent* is adversarial: receipts require substantive, relevant, fresh results; empty results, input echoes, `"No results found"` prose, and transport metadata satisfy nothing.
* Tool receipts are bound to the accepted call (`tool_use_id` + canonical argument digest) and consumed exactly once — a late, duplicate, or fabricated `PostToolUse` event cannot satisfy an obligation.
* Path prerequisites use literal comparison — suffix, backslash, and symlink/`..` alias impostors are rejected.
* Enforcement fails **closed** (a crashed hook cannot silently disable enforcement); advisory fails **open** (a dry run can never block).
* Session state and traces are written `0600` under the project's `.leadline/` directory.

What it does **not** yet defend against — disclosed, not hidden:

* **A hostile same-UID local user or root.** The exam harness documents a pre-publication hardening backlog for cross-user threat models (an audited `openat2(2)` path walk, content-addressed dependency provenance, same-UID adversary testing) in [docs/EXAM.md](docs/EXAM.md). If your deployment has mutually untrusting users on one machine, treat Leadline's guarantees as advisory until that backlog lands.
* **A compromised agent harness.** Leadline's enforcement is only as strong as the host's hook contract; a host that doesn't honor deny/block semantics degrades to advisory mode by design (capability negotiation), never silently.

## Supply chain

* No network calls, no telemetry, no LLM calls in the hook loop.
* Dependencies are minimal and locked; Dependabot alerts and secret scanning (with push protection) are enabled on this repository.
