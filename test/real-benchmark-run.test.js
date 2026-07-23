'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRealCorpus } = require('../src/benchmark');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('runs a manifest-bound real corpus and writes deterministic artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-real-'));
  const manifest = {
    schema_version: 1,
    corpus_commit: 'raw-sha',
    router_commit: 'router-sha',
    rubric_version: 'real-v1',
    rubric_commit: 'rubric-sha',
    labeler: 'dae',
    labeled_file: 'bench/labels.jsonl',
    results_dir: 'bench/results/real-v1',
  };
  const rows = [
    {
      id: 'a', prompt: 'history', source_hash: 's1', cluster_id: 'c1', gold_route: ['historical'],
      label_confidence: 'high', context_dependency: 'none', label_note: '', rubric_version: 'real-v1', labeler: 'dae',
    },
    {
      id: 'b', prompt: 'opinion', source_hash: 's2', cluster_id: 'c2', gold_route: [],
      label_confidence: 'high', context_dependency: 'none', label_note: '', rubric_version: 'real-v1', labeler: 'dae',
    },
  ];
  writeJson(path.join(root, 'bench', 'real-benchmark-manifest.json'), manifest);
  writeJsonl(path.join(root, 'bench', 'labels.jsonl'), rows);

  const planner = {
    plan(prompt) {
      return prompt === 'history'
        ? { steps: [{ need: 'historical' }], complete: true, unmatched_clauses: [] }
        : { steps: [], complete: false, unmatched_clauses: [{ index: 0 }] };
    },
  };

  const result = runRealCorpus(root, planner);
  assert.equal(result.report.metrics.first_route_accuracy.rate, 1);
  assert.equal(result.report.metrics.full_plan_exact_match.rate, 1);
  assert.equal(result.report.metadata.corpus_commit, 'raw-sha');
  assert.equal(fs.existsSync(path.join(root, 'bench/results/real-v1/dae-predictions.jsonl')), true);
  assert.equal(fs.existsSync(path.join(root, 'bench/results/real-v1/dae-misses.jsonl')), true);
  assert.equal(fs.existsSync(path.join(root, 'bench/results/real-v1/dae-report.json')), true);

  const reportBytes = fs.readFileSync(path.join(root, 'bench/results/real-v1/dae-report.json'), 'utf8');
  assert.equal(reportBytes.includes('latency_ms'), false);
  assert.equal(fs.readFileSync(path.join(root, 'bench/results/real-v1/dae-misses.jsonl'), 'utf8'), '');
});

test('returns null when the real benchmark manifest is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-no-real-'));
  assert.equal(runRealCorpus(root, { plan() { throw new Error('must not run'); } }), null);
});
