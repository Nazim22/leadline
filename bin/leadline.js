#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { runBenchmark } = require('../src/benchmark');
const { createPlanner } = require('../src/planner');
const {
  handleClaudeHook, installClaudeCode, planClaudeCodeInstall, readTrace, renderDecisionTrace,
} = require('../src/claude-code');

const root = path.join(__dirname, '..');

function takeOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new TypeError(`${name} requires a value`);
  return args[index + 1];
}

function positional(args, optionsWithValues = []) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionsWithValues.includes(args[index])) { index += 1; continue; }
    if (!args[index].startsWith('--')) values.push(args[index]);
  }
  return values;
}

function usage() {
  return [
    'usage:',
    '  leadline route <prompt>',
    '  leadline bench',
    '  leadline init --claude-code [--project <dir>] [--mode <advisory|enforce>] [--dry-run]',
    '  leadline hook <UserPromptSubmit|PreToolUse|PostToolUse|Stop> [--project <dir>]',
    '  leadline trace [--project <dir>] [--session <id>]',
    '',
  ].join('\n');
}

function installedHookMode(argv = process.argv.slice(2), cwd = process.cwd()) {
  if (argv[0] !== 'hook') return null;
  try {
    const args = argv.slice(1);
    const projectDir = path.resolve(takeOption(args, '--project', process.env.CLAUDE_PROJECT_DIR || cwd));
    const config = YAML.parse(fs.readFileSync(path.join(projectDir, '.leadline', 'config.yaml'), 'utf8'));
    return config?.mode === 'enforce' || config?.mode === 'advisory' ? config.mode : null;
  } catch {
    return null;
  }
}

function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const cwd = io.cwd || process.cwd();
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h') {
    stdout.write(usage());
    return 0;
  }
  if (command === 'bench') {
    runBenchmark(root);
    return 0;
  }
  if (command === 'route') {
    const prompt = args.join(' ').trim();
    if (!prompt) { stderr.write('usage: leadline route <prompt>\n'); return 2; }
    const planner = createPlanner({
      tellsPath: path.join(root, 'policy', 'tells.yaml'),
      routesPath: path.join(root, 'policy', 'routes.yaml'),
    });
    stdout.write(`${JSON.stringify(planner.plan(prompt), null, 2)}\n`);
    return 0;
  }
  if (command === 'init') {
    if (!args.includes('--claude-code')) { stderr.write('leadline init requires --claude-code\n'); return 2; }
    const projectDir = path.resolve(takeOption(args, '--project', cwd));
    const mode = takeOption(args, '--mode', 'enforce');
    if (!['enforce', 'advisory'].includes(mode)) throw new TypeError('mode must be advisory or enforce');
    const options = { projectDir, packageRoot: root, mode };
    const result = args.includes('--dry-run')
      ? planClaudeCodeInstall(options)
      : installClaudeCode(options);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (command === 'hook') {
    const event = positional(args, ['--project'])[0];
    if (!event) { stderr.write('leadline hook requires an event\n'); return 2; }
    const projectDir = path.resolve(takeOption(args, '--project', process.env.CLAUDE_PROJECT_DIR || cwd));
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input.hook_event_name !== event) throw new TypeError(`hook event mismatch: argv=${event} input=${input.hook_event_name}`);
    stdout.write(`${JSON.stringify(handleClaudeHook(input, { projectDir, packageRoot: root }))}\n`);
    return 0;
  }
  if (command === 'trace') {
    const projectDir = path.resolve(takeOption(args, '--project', cwd));
    const session = takeOption(args, '--session', null);
    if (!session) {
      stderr.write('leadline trace requires --session <id>\n');
      return 2;
    }
    stdout.write(renderDecisionTrace(readTrace(projectDir, session)));
    return 0;
  }
  stderr.write(usage());
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`leadline: ${error.message}\n`);
    if (installedHookMode() === 'advisory') {
      process.stdout.write('{}\n');
      process.exitCode = 0;
    } else {
      process.exitCode = process.argv[2] === 'hook' ? 2 : 1;
    }
  }
}

module.exports = { main, takeOption, usage };
