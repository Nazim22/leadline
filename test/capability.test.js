'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveCapability, CAPABILITIES, CAPABILITY_MAP_VERSION, capabilityMapSha } = require('../src/capability');

const bash = (command) => deriveCapability({ provider: 'bash', name: 'bash', args: { command } });

test('capability enum is closed and versioned', () => {
  assert.equal(CAPABILITY_MAP_VERSION, 'cap-v0.1');
  assert.deepEqual([...CAPABILITIES].sort(), [
    'historical.decision_recall', 'repository.commit_state', 'repository.current_bytes',
    'runtime.health_probe', 'runtime.test_run', 'structural.complete_callers',
  ]);
  assert.match(capabilityMapSha(), /^[a-f0-9]{64}$/);
});

// Dae's mandatory negative tests — capability is derived, and the wrong shape must NOT be authoritative.
test('arbitrary Bash is NOT authoritative (unknown => null)', () => {
  assert.equal(bash('echo hi'), null);
  assert.equal(bash('mkdir -p build'), null);
  assert.equal(bash('rm -rf tmp'), null);
});

test('a process-START command is not proof a service is healthy', () => {
  assert.equal(bash('node server.js &'), null);
  assert.equal(bash('systemctl start fleet-hub'), null);
});

test('a probe of a running service is runtime.health_probe', () => {
  assert.equal(bash('curl https://svc/health'), 'runtime.health_probe');
  assert.equal(bash('curl -sf http://localhost:8080/ready'), 'runtime.health_probe');
  assert.equal(bash('systemctl is-active fleet-hub'), 'runtime.health_probe');
});

test('running tests is runtime.test_run', () => {
  assert.equal(bash('npm test'), 'runtime.test_run');
  assert.equal(bash('node --test'), 'runtime.test_run');
  assert.equal(bash('pytest -q'), 'runtime.test_run');
});

test('reading one file / grep is repository.current_bytes, NOT structural completeness', () => {
  assert.equal(bash('cat src/x.js'), 'repository.current_bytes');
  assert.equal(bash('grep -n foo src/x.js'), 'repository.current_bytes');
  assert.equal(deriveCapability({ provider: 'read', name: 'read', args: { file: 'x' } }), 'repository.current_bytes');
  assert.notEqual(bash('grep -n foo src/x.js'), 'structural.complete_callers');
});

test('git read commands are repository.commit_state', () => {
  assert.equal(bash('git status'), 'repository.commit_state');
  assert.equal(bash('git rev-parse HEAD'), 'repository.commit_state');
});

test('graph tools are structural; gbrain recall is historical; other gbrain tools are not', () => {
  assert.equal(deriveCapability({ provider: 'mcp__graphify-cstore__query_graph', name: 'query_graph', args: {} }), 'structural.complete_callers');
  assert.equal(deriveCapability({ provider: 'mcp__code-review-graph__get_impact_radius_tool', name: 'x', args: {} }), 'structural.complete_callers');
  assert.equal(deriveCapability({ provider: 'mcp__gbrain__query', name: 'query', args: {} }), 'historical.decision_recall');
  assert.equal(deriveCapability({ provider: 'mcp__gbrain__put_page', name: 'put_page', args: {} }), null);
});

test('unknown provider and missing command => null (can never support)', () => {
  assert.equal(deriveCapability({ provider: 'unknown', name: 'x', args: {} }), null);
  assert.equal(deriveCapability({ provider: 'bash', name: 'bash', args: {} }), null);
  assert.equal(deriveCapability({}), null);
});
