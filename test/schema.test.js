'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { createPlanner } = require('../src/planner');
const { readJsonl } = require('../src/benchmark');

const root = path.join(__dirname, '..');

test('all benchmark and partial contracts validate against the public route-contract schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema', 'route-contract.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const planner = createPlanner({
    tellsPath: path.join(root, 'policy', 'tells.yaml'),
    routesPath: path.join(root, 'policy', 'routes.yaml'),
  });
  const cases = [
    ...readJsonl(path.join(root, 'bench', 'dev-corpus.jsonl')),
    ...readJsonl(path.join(root, 'bench', 'eval-corpus.jsonl')),
    { id: 'partial', prompt: 'Who calls alpha, then explain how to migrate it' },
  ];

  for (const row of cases) {
    const contract = planner.plan(row.prompt, { turnId: row.id });
    assert.equal(validate(contract), true, `${row.id}: ${JSON.stringify(validate.errors)}`);
  }
});
