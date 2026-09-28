# Leadline: context you can trace, not context you must trust

## Product promise
Leadline gives an agent a short route to the declared authoritative source, marks uncertainty and stale context, and turns detected context debt into explicit closure work. It does not determine truth from timestamps, replace authorization, or make arbitrary agents obey an MCP response.

## Small complete workflow
1. Install from the reviewed local source into an isolated environment; run `leadline init` in a project. Preview configuration changes, preserve unrelated host settings, and retain a reversible record of Leadline-owned changes. Repeating init must not duplicate hooks or overwrite authored context. A conflicting existing configuration must require explicit reconciliation.
2. Declare project-local source roots and authority, with portable relative paths. Our vault layout is an optional example, never a runtime default. Sources are data, not executable instructions; Leadline does not run commands extracted from documents.
3. Inspect ranked context: source path, authority tier, lifecycle, verification date/evidence and uncertainty. `retired`/`superseded` is different from old; old but unchanged is not proved incorrect. No stamp means unverified, failed observation means unknown. Do not automatically promote a document above live evidence or claim live verification without observing it.
4. Work the ranked queue: at most five displayed items, total backlog retained. Read-frequency ranking names its window and coverage. Verification records the source checked and a deliberate stamp; retirement is explicit. Re-detection closes findings. Closed baseline findings, still-open findings and arrivals are separate; an unreadable detector cannot manufacture improvement.
5. Check outcome trends: detected stale-source corrections per ten observed sessions, with counts, denominators and disjoint windows. This heuristic is not a verified error rate. Missing coverage is visible.

## Integration boundaries
- Claude Code: documented hook integration, project-scoped state and coverage-aware graph consultation. Explicit unsupported targets pass through; supported and ambiguous mixed searches retain their declared gate. A failed graph query is not proof of consultation success. Existing access/map and host permission controls are not removed or weakened.
- Other agents: read-only MCP discovery and context/queue access. Tool availability is not interception: without a host hook Leadline can advise but cannot prevent a direct read. Document and test this distinction.
- No public hosting, account requirement, telemetry upload, embeddings service or extra daemon is required for the local product. Do not copy personal transcripts into the release or benchmark.

## Definition of done for this release
- A clean temporary project can install, initialize twice, inspect context, exercise queue closure and use the MCP tools; existing user settings survive and removal only removes Leadline-owned wiring.
- Tests run without our home paths, vault, credentials or network. Generic entrypoints have no implicit access to our estate. Legacy seed scripts may remain clearly labeled as uninstalled historical inputs, not silently advertised as portable commands.
- A runnable fixture suite covers precedence, lifecycle, unknown coverage, path confinement, read-only MCP, graph coverage and project isolation, safe initialization, and retained access gates.
- Actual paired agent benchmark results are distinguished from deterministic unit tests, with raw responses, exact model/harness and source identities, all failures and small-sample limitations. No improvement is an acceptable result; hiding it is not.
- One head-bound final handoff includes local install instructions, executed checks/results, benchmark results, known limits and rollback/removal instructions. No package publishing or live installation is part of this build.

## Deliberate cuts
No universal fact extractor, autonomous document rewriting, truth scoring from prose, mandatory graph service, provider credential management, production remediation, or claim of preventing every stale-source mistake. Ship the inspect → act → recheck loop before adding dashboards or broader automation.

## Recorded failure scenarios (field-derived acceptance scenarios)
These are acceptance scenarios, not claims that a generic tool can infer semantic truth from arbitrary prose. The portable contract uses explicit source/claim metadata; absent metadata is visible uncertainty.

- **Fresh file, old claim:** verification belongs to a claim ID and subject/scope, not every sentence in the file. A new file-level date cannot renew an old operational claim. Undated `healthy`/`down` claims are unverified. Test a recently edited document whose old defect claim is contradicted by current source.
- **Supersession:** explicit same-scope supersession and later attributable records displace an undated summary; arbitrary newer files or unrelated subjects do not. Test a dated reversal against a verified-but-earlier finding and stale resume.
- **Effective state:** expose observed target identity, deployment commit and winning config tier. A local checkout/file value is not a deployment/DB observation. Test both disagreements without contacting production.
- **Evidence scope:** record population/scope, completeness and positive-control result. Truncated or filtered evidence cannot certify universal absence; a feature in one source cannot certify applicability to another object. Unknown evidence blocks a confident conclusion, not all unrelated work.
- **Provenance:** preserve author agent/model/session and supplied evidence on authored claim/rule records. Missing attribution stays unknown. Flag author-model/current-model mismatch as a notice, not a trust score or automatic reason to reject a correct rule. A document cannot elevate its own authority by claiming a higher tier than configured.
- **Handoff:** export canonical locators and claim/evidence identities, not an unversioned duplicated truth bundle. Stale chat quotes stay transport; recipients resolve the home and detect supersession.
- **Instrument control:** include a known-present probe and controlled negative in hook/detector checks. Missing/broken observations report unknown. A gate's success label is not proof the source was read or that it applies to the target.
- **Warning fatigue:** actionable bounded ranking with explicit closure beats repeated totals. Fixed-cohort remaining counts measure progress without hiding new arrivals, read failures, or unresolved items.

Each scenario needs a runnable fixture check; paired agent trials separately measure whether the agent chose the stale answer. Traceability links from the final README identify which scenarios are implemented, advisory only, or unsupported. No silent downgrade from an implementation claim to a documentation-only claim.
