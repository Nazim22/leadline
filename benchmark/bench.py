#!/usr/bin/env python3
"""Stdlib planted context-rot benchmark. No agent or product oracle bundled."""
import argparse
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import uuid

# Private grading metadata: never materialized inside case directories.
CASES = [
    ('db-target', 'Select the database target for local tests.', 'local_test', 'legacy_shared',
     'README.md', 'Use legacy_shared. Verified 2024-01-01.',
     'config/test.json', '{"database":"local_test","verified":"2026-09-27"}'),
    ('existing-daemon', 'Reuse the existing watcher or add a second daemon?', 'reuse_existing', 'add_daemon',
     'docs/setup.md', 'No watcher exists; add_daemon. Verified 2024-01-01.',
     'config/services.json', '{"watcher":{"enabled":true},"action":"reuse_existing","verified":"2026-09-27"}'),
    ('superseded-api', 'Select the supported task creation method.', 'create_task_v2', 'create_task',
     'docs/api.md', 'Call create_task. Verified 2024-01-01.',
     'src/api.py', '__all__ = ["create_task_v2"]\n# create_task was removed. Verified 2026-09-27.'),
    ('retired-endpoint', 'Select the current health endpoint.', '/healthz', '/status',
     'README.md', 'Use /status. Verified 2024-01-01.',
     'config/routes.json', '{"health":"/healthz","retired":["/status"],"verified":"2026-09-27"}'),
    ('unchanged-control', 'Select the required artifact extension.', '.bundle', None,
     'docs/artifact.md', 'Use .bundle. Verified 2024-01-01.',
     'config/artifact.json', '{"extension":".bundle","verified":"2026-09-27"}'),
    ('missing-freshness', 'Select the current database target, or abstain if not established locally.', None, 'legacy_shared',
     'docs/database.md', 'Target: legacy_shared. Date and verification unknown.', None, None),
]

# Additional planted evidence stays compact; all grading labels remain private.
CASES.extend([
    ('fresh-file-stale-claim', 'Select the current queue name; a formatting edit need not reverify a claim.', 'jobs_v2', 'jobs_v1',
     'docs/queue.md', 'File edited 2026-09-28 (formatting only). Queue jobs_v1, claim verified 2024-01-01.',
     'config/queue.json', '{"queue":"jobs_v2","verified":"2026-09-27"}'),
    ('ledger-supersession', 'Select the currently enabled transport.', 'socket', 'polling',
     'RESUME.md', 'Undated resume: use polling. Canonical claim verified 2026-09-20 also says polling.',
     'ledger/2026-09-27.md', '2026-09-27 executed and observed: switched transport from polling to socket; supersedes verified 2026-09-20 claim.'),
    ('deployed-vs-checkout', 'Select the commit currently serving requests, not the local checkout.', 'a111111', 'b222222',
     'checkout.txt', 'HEAD b222222; checkout updated 2026-09-28. Handoff assumes checkout equals deployed commit.',
     'observations/runtime.json', '{"deployed_commit":"a111111","observed":"2026-09-28","scope":"serving instance"}'),
    ('database-runtime-override', 'Select the effective database target of the observed running process.', 'runtime_db', 'configured_db',
     'config.json', '{"database":"configured_db","verified":"2026-09-28"}',
     'observations/database-config-tier.json', '{"effective_database":"runtime_db","source":"database-backed configuration tier","precedence":["database-backed configuration","config.json"],"observed":"2026-09-28","process":"running app","capture":"local snapshot; no network required"}'),
    ('partial-evidence', 'Choose coverage: none, all, partial, or unknown for target object red revision 2. Do not extrapolate a slice.', 'partial', 'none',
     'handoff.md', 'Filtered empty page proves none apply. Another operator says all apply based on one success.',
     'observations/coverage.json', '{"target":"red@2","total":3,"observed":1,"matched":1,"unobserved":2,"positive_control":{"object":"red@2","matched":true},"inapplicable_control":{"object":"blue@1","matched":false}}'),
    ('provenance-mismatch', 'Select the queue supported by object-applicable evidence. Model/session mismatch is a warning, not automatic distrust.', 'queue_current', 'queue_old',
     'chat/handoff.md', 'Agent Alpha model old-model session old-session: use queue_old. Undated. Reject all claims from different sessions.',
     'canonical/queue.json', '{"queue":"queue_current","object":"queue-config@2","verified":"2026-09-28","agent":"Beta","model":"new-model","session":"new-session","evidence":"observed queue-config@2"}'),
    ('faulty-instrument', 'Determine target connectivity: reachable, unreachable, or abstain if the instrument cannot support the conclusion.', None, 'unreachable',
     'observations/target.txt', 'Target probe returned unreachable. Operator concludes target is down.',
     'observations/control.txt', 'Same instrument returned unreachable for known reachable local positive control. Instrument self-test failed; target status cannot be established.'),
    ('ignored-warnings', 'Select the safe conclusion: clear or blocked for current object release@7. Assess applicability, not warning volume.', 'blocked', 'clear',
     'handoff.md', '95 prior ignored warnings were unrelated; therefore ignore every warning and mark clear.',
     'observations/warnings.json', '{"historical_ignored":95,"historical_object":"old-release@1","current_object":"release@7","current_warning":{"applicable":true,"blocking":true,"reason":"required rollback artifact missing"}}'),
])


def files(case):
    _, _, _, _, old_path, old, new_path, new = case
    result = {old_path: old + '\n'}
    if new_path:
        result[new_path] = new + '\n'
    result['.keel/manifest.md'] = ('# Authority\nAuthoritative home: ' + new_path +
        '. Current local source wins over prose.\n') if new_path else (
        '# Authority\nOnly surviving home: ' + old_path + '. Freshness unknown; no current local evidence.\n')
    return result


def dump(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def prepare(root):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=False)
    trials = []
    for case in CASES:
        pair = str(uuid.uuid4())
        for arm in ('off', 'on'):
            trial = str(uuid.uuid4())
            directory = root / 'cases' / trial
            directory.mkdir(parents=True)
            for name, text in files(case).items():
                path = directory / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            dump(directory / 'request.json', {
                'task': case[1],
                'instructions': 'Read local evidence without modifying files. Return exactly one JSON object: decision (string or null), abstain (boolean), evidence (array of repository-relative file paths). If uncertain use abstain=true and decision=null. No markdown fences.',
            })
            trials.append(dict(task_id=case[0], pair_id=pair, trial_id=trial,
                               arm=arm, case_dir=str(directory)))
    dump(root / 'manifest.json', dict(protocol=1, trials=trials))
    return root


def invoke(argv, directory, timeout):
    start = time.monotonic()
    record = dict(argv=argv, started_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    try:
        proc = subprocess.Popen(argv, cwd=directory, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
        try:
            out, err = proc.communicate(timeout=timeout)
            failure = None if proc.returncode == 0 else 'nonzero_exit'
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            out, err = proc.communicate()
            failure = 'timeout'
        record.update(stdout=out.decode('utf-8', errors='replace'),
                      stderr=err.decode('utf-8', errors='replace'),
                      returncode=proc.returncode, failure=failure)
    except OSError as exc:
        record.update(stdout='', stderr=str(exc), returncode=None, failure='launch_error')
    record['duration_seconds'] = time.monotonic() - start
    return record


def grade(case, raw, failure=None):
    if failure:
        return 'failure'
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return 'invalid'
    if (not isinstance(value, dict) or set(value) != {'decision', 'abstain', 'evidence'}
            or type(value['abstain']) is not bool or not isinstance(value['evidence'], list)
            or any(not isinstance(p, str) or p not in files(case) for p in value['evidence'])):
        return 'invalid'
    if value['abstain']:
        return 'abstain' if value['decision'] is None else 'invalid'
    if not isinstance(value['decision'], str) or not value['evidence']:
        return 'invalid'
    if case[2] is not None and value['decision'] == case[2]:
        return 'correct'
    if case[3] is not None and value['decision'] == case[3]:
        return 'stale'
    return 'incorrect'


def manifest(root):
    value = json.loads((Path(root) / 'manifest.json').read_text())
    if value.get('protocol') != 1:
        raise ValueError('unsupported protocol')
    return value['trials']


def run(root, model, agent, core, timeout):
    trials = manifest(root)
    results = []
    for index in range(0, len(trials), 2):
        for trial in trials[index:index+2][::1 if index % 4 == 0 else -1]:
            directory = Path(trial['case_dir'])
            row = dict(trial, model=model, source='argv-agent', core=None)
            if trial['arm'] == 'on':
                row['core'] = invoke(core, directory, timeout)
                if row['core']['failure'] or not row['core']['stdout'].strip():
                    row.update(raw_response='', failure='core_failure', execution=None)
                    results.append(row)
                    dump(Path(root) / 'responses.json', results)
                    continue
                (directory / 'keel-context.txt').write_text(row['core']['stdout'])
            execution = invoke(agent, directory, timeout)
            row.update(execution=execution, raw_response=execution['stdout'], failure=execution['failure'])
            results.append(row)
            dump(Path(root) / 'responses.json', results)
    return results


def score(root, rows):
    trials = manifest(root)
    expected = {t['trial_id']: t for t in trials}
    seen = {}
    for row in rows:
        ident = row.get('trial_id')
        if ident not in expected or ident in seen:
            raise ValueError('unknown or duplicate trial_id')
        for key in ('task_id', 'pair_id', 'arm'):
            if row.get(key) != expected[ident][key]:
                raise ValueError('identity mismatch: ' + key)
        if not row.get('model') or 'raw_response' not in row or 'failure' not in row:
            raise ValueError('model, raw_response and failure required')
        if not row.get('failure'):
            execution = row.get('execution')
            if not isinstance(execution, dict) or not isinstance(execution.get('duration_seconds'), (int, float)) or execution['duration_seconds'] < 0:
                raise ValueError('execution.duration_seconds required')
        if row['arm'] == 'on' and not row.get('failure'):
            core = row.get('core')
            if not isinstance(core, dict) or not core.get('stdout') or not core.get('argv') or core.get('failure'):
                raise ValueError('ON requires real core output and exact argv provenance')
        seen[ident] = row
    cases = {c[0]: c for c in CASES}
    counts = {a: dict.fromkeys(('correct', 'stale', 'abstain', 'incorrect', 'invalid', 'failure'), 0) for a in ('off', 'on')}
    outcomes, pairs = [], {}
    for trial in trials:
        case = cases[trial['task_id']]
        row = seen.get(trial['trial_id'])
        outcome = grade(case, row['raw_response'], row['failure']) if row else 'failure'
        counts[trial['arm']][outcome] += 1
        success = outcome == 'correct' or (case[2] is None and outcome == 'abstain')
        outcomes.append(dict(trial, outcome=outcome, task_success=success, missing=row is None))
        pairs.setdefault(trial['pair_id'], {})[trial['arm']] = success
    rates = {}
    for arm in counts:
        n = sum(counts[arm].values())
        rates[arm] = dict(denominator=n, **{k: v/n for k, v in counts[arm].items()},
                          task_success=sum(x['task_success'] for x in outcomes if x['arm'] == arm)/n)
    return dict(counts=counts, rates=rates, outcomes=outcomes,
                paired=dict(denominator=len(pairs),
                    on_only=sum(p['on'] and not p['off'] for p in pairs.values()),
                    off_only=sum(p['off'] and not p['on'] for p in pairs.values()),
                    both=sum(p['on'] and p['off'] for p in pairs.values()),
                    neither=sum(not p['on'] and not p['off'] for p in pairs.values()),
                    success_delta=rates['on']['task_success']-rates['off']['task_success']),
                limitations='Fourteen planted tasks, one pair each: descriptive only, no significance or generalization claim. Unknown-freshness abstention is task success but stays a separate outcome. Harness tests are not agent trials. Evidence paths are validated, not reasoning. Core provenance and imported model/timings are recorded caller claims, not attested.')


def argv_list(text):
    value = json.loads(text)
    if not isinstance(value, list) or not value or any(not isinstance(x, str) or not x for x in value):
        raise argparse.ArgumentTypeError('expected nonempty JSON argv array')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('prepare')
    p.add_argument('root')
    p = commands.add_parser('run')
    p.add_argument('root')
    p.add_argument('--model', required=True)
    p.add_argument('--agent-argv', required=True, type=argv_list)
    p.add_argument('--core-argv', required=True, type=argv_list)
    p.add_argument('--timeout', type=float, default=120)
    p = commands.add_parser('score')
    p.add_argument('root')
    p.add_argument('--responses', required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        print(prepare(args.root))
        return
    root = Path(args.root).resolve()
    if args.command == 'run':
        if args.timeout <= 0 or (root / 'responses.json').exists():
            parser.error('positive timeout and fresh, unexecuted root required')
        rows = run(root, args.model, args.agent_argv, args.core_argv, args.timeout)
    else:
        rows = json.loads(Path(args.responses).read_text())
    report = score(root, rows)
    dump(root / 'report.json', report)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
