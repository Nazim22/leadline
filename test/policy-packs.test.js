'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020');
const YAML = require('yaml');
const { loadPolicyPacks, negotiateAdapterMode } = require('../src/contract-engine');

const root = path.join(__dirname, '..');
const schemaPath = path.join(root, 'schema', 'policy-pack.schema.json');

function publicPack(pack) {
  return { ...pack, rules: pack.rules.map(({ pack_id: _packId, ...rule }) => rule) };
}

test('the three launch packs load and validate against the public schema', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const packs = loadPolicyPacks({ directory: path.join(root, 'policy', 'packs'), schemaPath });
  assert.deepEqual(packs.map((pack) => pack.id).sort(), [
    'authoritative-source-before-memory',
    'code-intelligence-before-raw-search',
    'prerequisite-before-protected-ops',
  ]);
  for (const pack of packs) {
    assert.equal(validate(publicPack(pack)), true, JSON.stringify(validate.errors));
    assert.equal(pack.schema_version, '1.0');
    for (const rule of pack.rules) {
      assert.ok(rule.why.length > 0);
      assert.equal(rule.satisfies, 'real_result_only');
      assert.ok(rule.sanctioned_fallback.length > 0);
      assert.ok(Number.isInteger(rule.ttl) && rule.ttl >= 0);
    }
  }
});

test('pack validation rejects opinion rules without a burn receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-pack-invalid-'));
  fs.writeFileSync(path.join(dir, 'bad.yaml'), [
    'schema_version: "1.0"',
    'id: bad-pack',
    'version: "1.0.0"',
    'description: bad',
    'required_capabilities: [deny_tool_call]',
    'rules:',
    '  - id: bad-rule',
    '    trigger: { when_family: structural }',
    '    required_family: structural',
    '    preferred_route: code_callers',
    '    sanctioned_fallback: grep with disclosure',
    '    satisfies: real_result_only',
    '    denial_template: { unmet: x, corrective: y, alternative: z }',
    '    ttl: 60',
  ].join('\n'));
  assert.throws(() => loadPolicyPacks({ directory: dir, schemaPath }), /why/);
});

test('schema and runtime both reject whitespace-only strings', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const source = loadPolicyPacks({ directory: path.join(root, 'policy', 'packs'), schemaPath })[0];
  const pack = structuredClone(publicPack(source));
  pack.rules[0].preferred_route = ' ';
  assert.equal(validate(pack), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadline-pack-whitespace-'));
  fs.writeFileSync(path.join(dir, 'bad.yaml'), YAML.stringify(pack));
  assert.throws(() => loadPolicyPacks({ directory: dir, schemaPath }), /invalid policy pack/);
});

test('runtime validation rejects every empty selector exactly as the schema does', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const selectors = ['tool_names', 'input_patterns', 'obligation_patterns', 'attempted_families'];
  for (const selector of selectors) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `leadline-pack-empty-${selector}-`));
    fs.writeFileSync(path.join(dir, 'bad.yaml'), [
      'schema_version: "1.0"', 'id: bad-pack', 'version: "1.0.0"', 'description: bad',
      'required_capabilities: [deny_tool_call]', 'rules:', '  - id: bad-rule',
      `    trigger: { when_family: structural, ${selector}: [] }`,
      '    required_family: structural', '    preferred_route: code_callers',
      '    sanctioned_fallback: explicitly abstain', '    satisfies: real_result_only',
      '    denial_template: { unmet: x, corrective: y, alternative: z }',
      '    why: required', '    ttl: 60',
    ].join('\n'));
    assert.throws(() => loadPolicyPacks({ directory: dir, schemaPath }), new RegExp(selector));
    assert.equal(schema.properties.rules.items.properties.trigger.properties[selector].minItems, 1);
  }
});

test('capability negotiation selects the strongest honest adapter mode', () => {
  assert.equal(negotiateAdapterMode({
    inject_before_action: true, intercept_tool_call: true, deny_tool_call: true,
    inspect_tool_result: true, block_completion: true,
  }), 'ENFORCE');
  assert.equal(negotiateAdapterMode({ intercept_tool_call: true, deny_tool_call: true }), 'PARTIAL_ENFORCE');
  assert.equal(negotiateAdapterMode({ inject_before_action: true, inspect_tool_result: true }), 'ADVISE');
  assert.equal(negotiateAdapterMode({ inspect_tool_result: true }), 'AUDIT');
  assert.equal(negotiateAdapterMode({}), 'AUDIT');
});

test('adapter capability schema validates all negotiated modes without conflating them', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema', 'adapter-capabilities.schema.json'), 'utf8'));
  assert.deepEqual(schema.required, [
    'schema_version', 'mode', 'inject_before_action', 'intercept_tool_call', 'deny_tool_call',
    'request_human_approval', 'inspect_tool_result', 'block_completion',
  ]);
  assert.equal(schema.properties.schema_version.const, '1.0');
  assert.deepEqual(schema.properties.mode.enum, ['ENFORCE', 'PARTIAL_ENFORCE', 'ADVISE', 'AUDIT']);
  for (const key of [
    'inject_before_action', 'intercept_tool_call', 'deny_tool_call', 'request_human_approval',
    'inspect_tool_result', 'block_completion',
  ]) assert.equal(schema.properties[key].type, 'boolean');
});
