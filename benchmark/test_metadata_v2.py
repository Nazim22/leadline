import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import bench
import core_adapter
import metadata_v2


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = bench.prepare(Path(self.temp.name) / 'v2', 2)
        self.trials = bench.manifest(self.root)

    def test_fourteen_symmetric_pairs_source_quotes_and_digests(self):
        self.assertEqual(len(self.trials), 28)
        for a, b in zip(self.trials[::2], self.trials[1::2]):
            def snapshot(t):
                root = Path(t['case_dir'])
                return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}
            self.assertEqual(snapshot(a), snapshot(b))
            root = Path(a['case_dir'])
            sources = {s['id']: s for s in json.loads((root / '.sourcemark/sources.json').read_text())['sources']}
            for claim in json.loads((root / '.sourcemark/claims.json').read_text())['claims']:
                data = (root / sources[claim['source']]['path']).read_bytes()
                self.assertEqual(claim['source_digest'], hashlib.sha256(data).hexdigest())
                self.assertEqual(claim['value'], data.decode().splitlines()[int(claim['locator'].rsplit(':', 1)[1])-1])
                self.assertTrue(all(v.startswith('FICTIONAL') for v in claim['writer'].values()))
                self.assertIn('FICTIONAL FIXTURE RECORDS', claim['evidence']['fixture_notice'])

    def test_hidden_keys_cannot_influence_registries(self):
        for case in bench.CASES:
            poisoned = (*case[:2], 'SECRET-CORRECT', 'SECRET-STALE', *case[4:])
            self.assertEqual(metadata_v2.registries(bench.files(case), case[0]),
                             metadata_v2.registries(bench.files(poisoned), case[0]))
        with patch.object(bench, 'CASES', [('x', 'q', 'HIDDEN', 'KEY', 'a.txt', 'Visible only.', None, None)]):
            root = bench.prepare(Path(self.temp.name) / 'poison', 2)
            for trial in bench.manifest(root):
                text = ''.join(p.read_text() for p in Path(trial['case_dir']).rglob('*') if p.is_file())
                self.assertNotIn('HIDDEN', text)
                self.assertNotIn('KEY', text)

    def test_controls_and_no_answer_summary(self):
        for task in ('missing-freshness', 'partial-evidence', 'faulty-instrument', 'provenance-mismatch'):
            trial = next(t for t in self.trials if t['task_id'] == task)
            d = Path(trial['case_dir'])
            self.assertFalse((d / 'keel-context.txt').exists())
            claims = json.loads((d / '.sourcemark/claims.json').read_text())['claims']
            if task in ('missing-freshness', 'partial-evidence', 'faulty-instrument'):
                self.assertTrue(all(c['verified_at'] is None for c in claims))
            if task == 'provenance-mismatch':
                self.assertTrue(any('new-session' in c['value'] for c in claims))
        # Conflicting original records survive: no correct-answer-only registry.
        case = bench.CASES[0]
        claims = json.loads(metadata_v2.registries(bench.files(case), case[0])['.sourcemark/claims.json'])['claims']
        self.assertEqual(len(claims), 2)
        self.assertNotEqual(claims[0]['value'], claims[1]['value'])
        self.assertEqual(claims[0]['verified_at'], '2024-01-01T00:00:00Z')

    def test_registry_citations_versioned_scoring(self):
        case = bench.CASES[0]
        for path in metadata_v2.REGISTRY_PATHS:
            raw = json.dumps(dict(decision=case[2], abstain=False, evidence=[path]))
            self.assertEqual(bench.grade(case, raw, protocol=2), 'correct')
            self.assertEqual(bench.grade(case, raw), 'invalid')
        self.assertEqual(json.loads((self.root / 'manifest.json').read_text())['variant'], metadata_v2.VARIANT)

    def test_unknown_delivery_preserves_raw_failure_and_rejects_crashes(self):
        unknown = dict(stdout=json.dumps(dict(status='unknown', subject='x', scope='s')),
                       stderr='diagnostic', returncode=3, failure='nonzero_exit')
        self.assertTrue(core_adapter.delivered(unknown, 'x', 's'))
        for change in ({'returncode': 1}, {'failure': 'timeout'}, {'failure': 'launch_error'},
                       {'stdout': 'crash'}, {'returncode': 0}):
            self.assertFalse(core_adapter.delivered(dict(unknown, **change), 'x', 's'))
        self.assertFalse(core_adapter.delivered(unknown, 'other', 's'))
        trial = self.trials[1]
        core = dict(unknown, stdout=json.dumps(dict(status='unknown', subject=trial['task_id'], scope='source-observations')),
                    argv=['node', '/p/bin/sourcemark.js', 'context'], product_commit=core_adapter.FROZEN_PRODUCT,
                    registry_schema_sha256=core_adapter.SCHEMA_DIGEST)
        row = dict(trial, model='TEST-NOT-AGENT', raw_response='{"decision":null,"abstain":true,"evidence":[]}',
                   failure=None, execution={'duration_seconds': 0}, core=core)
        self.assertEqual(bench.score(self.root, [row])['counts']['on']['abstain'], 1)
        self.assertEqual(core['returncode'], 3)
        self.assertEqual(core['failure'], 'nonzero_exit')
        self.assertEqual(core['stderr'], 'diagnostic')
        row['core'] = dict(core, failure='launch_error')
        with self.assertRaises(ValueError):
            bench.score(self.root, [row])

    def test_adapter_exact_public_argv_and_raw_record(self):
        trial = self.trials[1]
        def invoke(argv, directory, timeout):
            self.assertEqual(argv[2:4], ['context', '--project'])
            self.assertEqual(argv[4], str(Path(trial['case_dir']).resolve()))
            self.assertEqual(argv[5:9], ['--subject', trial['task_id'], '--scope', 'source-observations'])
            self.assertEqual(argv[-1], '--json')
            return dict(argv=argv, stdout=json.dumps(dict(status='unknown', subject=trial['task_id'], scope='source-observations')),
                        stderr='raw', returncode=3, failure='nonzero_exit')
        with patch.object(core_adapter, 'verify_product', return_value=Path('/frozen')):
            r = core_adapter.context(trial['case_dir'], '/frozen', core_adapter.FROZEN_PRODUCT, 1, invoke)
        self.assertTrue(r['delivered'])
        self.assertEqual((r['returncode'], r['stderr'], r['failure']), (3, 'raw', 'nonzero_exit'))

    def test_v2_runner_delivers_unknown_and_retains_crash(self):
        agent = [sys.executable, '-c', 'print(\'{"decision":null,"abstain":true,"evidence":[]}\')']
        def context(directory, product, commit, timeout, invoke):
            selector = json.loads((Path(directory) / '.sourcemark/selector.json').read_text())
            crash = selector['subject'] == 'db-target'
            return dict(argv=['TEST-CORE-STUB-NOT-PRODUCT'], stdout=json.dumps(dict(
                status='unknown', subject=selector['subject'], scope=selector['scope'])),
                stderr='raw diagnostic', returncode=1 if crash else 3, failure='nonzero_exit',
                delivered=not crash, product_commit=commit, registry_schema_sha256=core_adapter.SCHEMA_DIGEST)
        with patch.object(core_adapter, 'verify_product'), patch.object(core_adapter, 'context', side_effect=context):
            rows = bench.run(self.root, 'SCRIPTED-NOT-AGENT', agent, None, 2, '/frozen')
        report = bench.score(self.root, rows)
        self.assertEqual(report['counts']['on']['failure'], 1)
        self.assertEqual(report['counts']['on']['abstain'], 13)
        for row in rows:
            exists = (Path(row['case_dir']) / 'keel-context.txt').exists()
            self.assertEqual(exists, row['arm'] == 'on' and row['task_id'] != 'db-target')
            if exists:
                self.assertEqual(row['core']['returncode'], 3)
                self.assertEqual(row['core']['failure'], 'nonzero_exit')
                self.assertEqual(row['core']['stderr'], 'raw diagnostic')
                self.assertEqual((Path(row['case_dir']) / 'keel-context.txt').read_text(), row['core']['stdout'])

    @unittest.skipUnless(os.environ.get('SOURCEMARK_TEST_PRODUCT'), 'set SOURCEMARK_TEST_PRODUCT to clean pinned product')
    def test_real_frozen_public_cli_all_cases(self):
        statuses = []
        for trial in self.trials[1::2]:
            r = core_adapter.context(trial['case_dir'], os.environ['SOURCEMARK_TEST_PRODUCT'],
                                     core_adapter.FROZEN_PRODUCT, 10, bench.invoke)
            self.assertTrue(r['delivered'], r)
            self.assertEqual(r['argv'][1].split('/')[-1], 'sourcemark.js')
            self.assertEqual(r['product_commit'], core_adapter.FROZEN_PRODUCT)
            self.assertIn(r['returncode'], (0, 3))
            statuses.append(r['returncode'])
        self.assertIn(0, statuses)
        self.assertIn(3, statuses)


if __name__ == '__main__':
    unittest.main()
