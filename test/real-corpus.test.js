'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');

const root = path.join(__dirname, '..');

function validator() {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema', 'real-label.schema.json'), 'utf8'));
  return new Ajv2020({ strict: false }).compile(schema);
}

function validRow() {
  return {
    id: 'real-000001',
    prompt: 'What did we decide, and is it live?',
    source_hash: 'opaque',
    cluster_id: 'c-1',
    gold_route: ['historical', 'runtime'],
    label_confidence: 'high',
    context_dependency: 'referent',
    label_note: '',
    rubric_version: 'real-v1',
    labeler: 'dae',
  };
}

test('real label schema accepts the frozen annotation shape', () => {
  const validate = validator();
  assert.equal(validate(validRow()), true, JSON.stringify(validate.errors));
});

test('real label schema rejects unknown evidence families', () => {
  const validate = validator();
  const row = validRow();
  row.gold_route = ['web'];
  assert.equal(validate(row), false);
});

test('real label schema rejects annotations that mutate the shape', () => {
  const validate = validator();
  const row = validRow();
  row.predicted_route = ['historical'];
  assert.equal(validate(row), false);
});
