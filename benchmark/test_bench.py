import json
from pathlib import Path
import sys
import tempfile
import unittest

import bench


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = bench.prepare(Path(self.tmp.name) / 'run')
        self.trials = bench.manifest(self.root)

    def answer(self, decision, abstain=False, evidence=None):
        return json.dumps(dict(decision=decision, abstain=abstain,
                               evidence=evidence if evidence is not None else ['README.md']))

    def test_fixtures_fresh_paired_and_no_grading_leak(self):
        self.assertEqual(len(self.trials), 28)
        self.assertEqual(len({t['pair_id'] for t in self.trials}), 14)
        for a, b in zip(self.trials[::2], self.trials[1::2]):
            self.assertEqual(a['pair_id'], b['pair_id'])
            content = []
            for t in (a, b):
                d = Path(t['case_dir'])
                content.append({str(p.relative_to(d)): p.read_text() for p in d.rglob('*') if p.is_file()})
                self.assertFalse((d / 'manifest.json').exists())
                request = json.loads((d / 'request.json').read_text())
                self.assertEqual(set(request), {'task', 'instructions'})
            self.assertEqual(content[0], content[1])
        with self.assertRaises(FileExistsError):
            bench.prepare(self.root)

    def test_all_grading_outcomes_and_exact_matching(self):
        case = bench.CASES[0]
        for raw, expected in [
            (self.answer('local_test'), 'correct'),
            (self.answer('legacy_shared'), 'stale'),
            (self.answer(None, True), 'abstain'),
            (self.answer('prefix local_test'), 'incorrect'),
            (self.answer('local_test', evidence=['../answer']), 'invalid'),
            (self.answer('local_test', True), 'invalid'),
            (self.answer('local_test', evidence=[]), 'invalid'),
            ('local_test', 'invalid'), ('[]', 'invalid'),
            ('{"decision":"local_test"}', 'invalid'),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(bench.grade(case, raw), expected)
        self.assertEqual(bench.grade(case, self.answer('local_test'), 'timeout'), 'failure')
        self.assertEqual(bench.grade(bench.CASES[-1], self.answer(None, True, [])), 'abstain')

    def row(self, t, decision=None, failure=None):
        return dict(t, model='TEST-NOT-AGENT', raw_response=self.answer(decision, decision is None, [] if decision is None else ['README.md']),
                    failure=failure, execution={'duration_seconds': 0.1},
                    core={'argv':['TEST-NOT-KEEL'], 'stdout':'TEST', 'failure':None})

    def test_missing_failure_denominators(self):
        rows = [self.row(self.trials[0], 'local_test'), self.row(self.trials[1], 'local_test', 'timeout')]
        report = bench.score(self.root, rows)
        self.assertEqual(report['rates']['off']['denominator'], 14)
        self.assertEqual(report['counts']['on']['failure'], 14)
        self.assertEqual(report['paired']['off_only'], 1)
        self.assertEqual(report['paired']['denominator'], 14)
        self.assertEqual(sum(x['missing'] for x in report['outcomes']), 26)

    def test_reject_bad_pairs_duplicates_unknown_core_and_timing(self):
        good = self.row(self.trials[1])
        bad_rows = [[good, good], [dict(good, trial_id='missing')], [dict(good, pair_id='wrong')],
                    [dict(good, core=None)], [dict(good, execution={})]]
        for rows in bad_rows:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                bench.score(self.root, rows)

    def test_unknown_abstain_is_separate_success(self):
        report = bench.score(self.root, [self.row(t) for t in self.trials])
        self.assertEqual(report['counts']['on']['abstain'], 14)
        self.assertEqual(report['rates']['on']['task_success'], 2/14)
        self.assertEqual(report['rates']['on']['correct'], 0)

    def test_timeout_nonzero_launch_and_literal_argv(self):
        r = bench.invoke([sys.executable, '-c', 'import time; time.sleep(10)'], self.root, .03)
        self.assertEqual(r['failure'], 'timeout')
        self.assertLess(r['duration_seconds'], 2)
        self.assertEqual(bench.invoke([sys.executable, '-c', 'raise SystemExit(3)'], self.root, 1)['failure'], 'nonzero_exit')
        self.assertEqual(bench.invoke(['/missing/executable'], self.root, 1)['failure'], 'launch_error')
        r = bench.invoke([sys.executable, '-c', 'import sys; print(sys.argv[1])', '$(touch nope)'], self.root, 1)
        self.assertEqual(r['stdout'].strip(), '$(touch nope)')
        self.assertFalse((self.root / 'nope').exists())

    def test_runner_protocol_scripted_not_agent_benchmark(self):
        agent = [sys.executable, '-c', 'import json; print(json.dumps(dict(decision=None, abstain=True, evidence=[])))']
        core = [sys.executable, '-c', 'print("TEST CORE PROTOCOL STUB — NOT KEEL")']
        rows = bench.run(self.root, 'TEST-NOT-AGENT', agent, core, 2)
        self.assertEqual(len(rows), 28)
        for row in rows:
            self.assertEqual((Path(row['case_dir']) / 'keel-context.txt').exists(), row['arm'] == 'on')
            self.assertIn('duration_seconds', row['execution'])
        self.assertEqual(bench.score(self.root, rows)['paired']['both'], 2)

    def test_incorrect_distinct_from_invalid_in_report(self):
        rows = [self.row(self.trials[0], 'other_target')]
        report = bench.score(self.root, rows)
        self.assertEqual(report['counts']['off']['incorrect'], 1)
        self.assertEqual(report['counts']['off']['invalid'], 0)
        self.assertEqual(report['rates']['off']['incorrect'], 1/14)
        self.assertEqual(report['rates']['off']['task_success'], 0)

    def test_database_backed_tier_fixture(self):
        case = next(c for c in bench.CASES if c[0] == 'database-runtime-override')
        fixture = bench.files(case)
        observed = json.loads(fixture['observations/database-config-tier.json'])
        self.assertEqual(observed['precedence'], ['database-backed configuration', 'config.json'])
        self.assertEqual(observed['effective_database'], case[2])
        self.assertEqual(json.loads(fixture['config.json'])['database'], case[3])
        self.assertNotIn('DATABASE_TARGET', json.dumps(fixture))

    def test_core_failure_retained(self):
        agent = [sys.executable, '-c', 'print("bad")']
        rows = bench.run(self.root, 'TEST-NOT-AGENT', agent, ['/missing/core'], 1)
        self.assertEqual(bench.score(self.root, rows)['counts']['on']['failure'], 14)


if __name__ == '__main__':
    unittest.main()
