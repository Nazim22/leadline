#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createPlanner } = require('../src/planner');
const { runBenchmark } = require('../src/benchmark');

const root = path.join(__dirname, '..');
const [command, ...args] = process.argv.slice(2);

if (command === 'bench') {
  runBenchmark(root);
} else if (command === 'route') {
  const prompt = args.join(' ').trim();
  if (!prompt) {
    console.error('usage: leadline route <prompt>');
    process.exitCode = 2;
  } else {
    const planner = createPlanner({
      tellsPath: path.join(root, 'policy', 'tells.yaml'),
      routesPath: path.join(root, 'policy', 'routes.yaml'),
    });
    console.log(JSON.stringify(planner.plan(prompt), null, 2));
  }
} else {
  console.log('usage: leadline <route <prompt> | bench>');
  process.exitCode = command ? 2 : 0;
}
