# Planted context-rot benchmark (protocol 1)

Stdlib Python 3. Fourteen tiny synthetic repositories, starting with: wrong DB target, existing daemon,
superseded API, retired endpoint, unchanged old-document control, and unknown
freshness. **No product result or agent efficacy claim is included.** The tests use
explicitly labeled protocol stubs, not Leadline and not model trials.

## CLI

```sh
python3 -m unittest discover -s benchmark -v
python3 benchmark/bench.py prepare /absolute/new/run-directory
python3 benchmark/bench.py run /absolute/new/run-directory \
  --model 'provider/exact-model-version' \
  --agent-argv '["/absolute/agent-adapter"]' \
  --core-argv '["/absolute/real-leadline-adapter"]' --timeout 120
python3 benchmark/bench.py score /absolute/new/run-directory \
  --responses /absolute/imported-responses.json
```

`prepare` refuses existing roots. Each arm gets an independent fresh case directory,
with identical baseline files and request. OFF still has the repository's manifest;
ON adds actual Leadline output. This tests **Leadline activation**, not withholding source
from OFF. Pair order alternates. `run` refuses an existing responses file; prepare a
new run rather than reuse modified directories. Results checkpoint after each trial.

## Adapter contract (core integration pending until real core is available)

Both adapters receive **no implicit arguments**, and run with cwd equal to the case
directory. JSON argv arrays are passed directly to `Popen`, never shell/eval.

* Agent adapter reads `request.json`, repository files, and (only when present)
  `keel-context.txt`. Stdout must be exactly one response JSON object. Stderr is
  retained. Pass the same model/settings to both arms, fresh agent context each time.
* Core adapter runs real Leadline against cwd and writes its unmodified product context
  to stdout. Exit nonzero or empty output becomes a retained ON failure. The runner
  saves stdout to `keel-context.txt`, then invokes the agent. Record exact executable
  argv, core version/SHA and configuration in the experiment record; do not replace
  Leadline with a handwritten answer generator.
* Timeout kills the process group. No built-in networking or dependencies; adapters
  themselves are trusted executables, not sandboxed. **cwd is not a security boundary.**
  Agent tooling must restrict accessible files to its own case directory. Never expose
  this harness, its CASES constants, parent run manifest, results, or sibling trials.
  The runner cannot enforce filesystem isolation. Prefer import mode for externally
  sandboxed subagents and explicitly document their isolation.

Response schema, no additional keys:

```json
{"decision":"local_test","abstain":false,"evidence":["config/test.json"]}
```

Use exact decision tokens grounded in the source. For abstention use decision=null,
abstain=true. Evidence must name existing fixture paths (empty permitted only when
abstaining). String mentions/substrings never win. Grading metadata is kept in the
harness, not copied into agent directories. The visible fixture source necessarily
contains the actual target values; that is evidence, not a hidden grading label.

## Import contract

Copy trial_id/task_id/pair_id/arm from the private `manifest.json` into a JSON array
of response records. Include `model`, `source` (recommend `external-agent`),
`raw_response` (original JSON **string**, not normalized), `failure` (null or failure
reason), and `execution` with duration_seconds, started_at, stderr and any run ID.
Successful ON records require `core` with exact argv and original stdout; preserve
its duration_seconds, stderr, returncode and failure as in direct runner output.
Attach additional provenance fields as needed; the scorer preserves raw imports at
source and writes only `report.json`. Keep imports/raw artifacts with the report.
Unknown/duplicate trial IDs and mismatched pairing metadata are rejected. Missing
trials and declared failures remain in the fourteen-per-arm denominator. No silent drop.

Reports separate correct, stale, abstain, incorrect, invalid and failure, plus task success:
correct decisions, or abstention for the unknown-freshness task. Paired counts and
ON-minus-OFF task-success rate use all fourteen pairs. No significance or generalization
claim at this size. Evidence path validity does not prove sound reasoning; imported
provenance/timings are caller claims. Save raw responses and audit representative
reasoning before making efficacy claims. The harness does not validate product
semantics, isolate adapters, or certify a trial as genuine agent execution.


## Expanded coverage

The additional eight cases cover a freshly edited file with an old claim; dated
ledger superseding a verified claim and undated resume; deployed commit versus
checkout; database-backed configuration tier overriding config.json; partial coverage with applicable
positive/inapplicable controls; stale chat versus canonical evidence with agent,
model and session mismatch; faulty instrument failing a known-positive control;
and 95 historical ignored warnings versus one applicable current blocker.
Mismatch is not automatic distrust. The partial case rejects both none and all
(the planted none is classified stale; all is incorrect). Two cases require abstention.

Exact response import record (one per scheduled trial):

```json
{
  "trial_id": "COPY_FROM_MANIFEST",
  "task_id": "COPY_FROM_MANIFEST",
  "pair_id": "COPY_FROM_MANIFEST",
  "arm": "on",
  "model": "provider/exact-model-version",
  "agent_id": "agent-name",
  "session_id": "actual-session-id",
  "source": "external-agent",
  "raw_response": "{\"decision\":null,\"abstain\":true,\"evidence\":[]}",
  "failure": null,
  "execution": {
    "started_at": "2026-09-28T00:00:00Z",
    "duration_seconds": 1.2,
    "stderr": ""
  },
  "core": {
    "argv": ["/absolute/real-leadline-adapter"],
    "stdout": "UNMODIFIED REAL PRODUCT OUTPUT",
    "stderr": "",
    "returncode": 0,
    "failure": null,
    "duration_seconds": 0.1,
    "product_commit": "ACTUAL_CORE_SHA"
  }
}
```

OFF uses core=null. Wrap records in a JSON array. agent_id/session_id/product_commit
are retained provenance fields; scorer requires model and successful timing, not
cross-session equality. Failures use a nonempty failure reason and raw_response
(empty string if no output). Importing cannot prove real execution: parent must
retain the actual session and core artifacts. Manifest protocol 1 contains trials
with trial_id, task_id, pair_id, arm, case_dir; only request.json and case-local
files should reach the agent, never private manifest or harness sources.

Well-formed non-abstaining decisions matching neither expected nor planted stale
values are `incorrect`; malformed schema or invalid evidence paths are `invalid`.
The DB-tier fixture is a local observation snapshot, never a database/network call.
