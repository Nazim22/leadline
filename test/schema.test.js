'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { createPlanner } = require('../src/planner');

const root = path.join(__dirname, '..');

test('generated contracts validate against the public route-contract schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema', 'route-contract.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const planner = createPlanner({
    tellsPath: path.join(root, 'policy', 'tells.yaml'),
    routesPath: path.join(root, 'policy', 'routes.yaml'),
  });
  const contract = planner.plan('Did we ship promotions, and where is applyPromo defined?');

  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
});
