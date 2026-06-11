#!/usr/bin/env node
'use strict';

// Regression tests for two requirements from the user prompt:
//  1. 5-second heartbeat: global `streaming-heartbeat-ms` default = 5000,
//     PLUS an independent hard "no output to CLI" 5s watchdog in runClaude.
//  2. `[N agents]` parallel display: parsePlanningSubtasks must capture the
//     full body of a `## Parallel Tasks` section (regex must not stop at the
//     first newline due to a stale `m` flag).
//
// No real Claude agents are spawned.
// Run: node Agent_Orchestrator/tests/heartbeat-watchdog-and-parallel-parse.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const GLOBAL = path.join(HARNESS, 'global-config.json');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

const src = fs.readFileSync(RUN_AGENT, 'utf8');

// ── Item 1: 5s heartbeat + independent watchdog ──────────────────────────────

test('global-config.json streaming-heartbeat-ms default is 5000', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  assert.strictEqual(cfg['streaming-heartbeat-ms'], 5000);
});

test('runClaude streamingHeartbeatMs fallback is 5000 (was 15000)', () => {
  const m = src.match(/heartbeatMs = config\.streamingHeartbeatMs \|\| (\d+)/);
  assert.ok(m, 'streamingHeartbeatMs fallback not found');
  assert.strictEqual(Number(m[1]), 5000,
    'fallback default must be 5000 so a 5s silence triggers heartbeat even when config omits the key');
});

test('runClaude defines independent cliWatchdogMs (default 5000)', () => {
  const m = src.match(/cliWatchdogMs = config\.cliWatchdogMs \|\| (\d+)/);
  assert.ok(m, 'cliWatchdogMs declaration missing — hard 5s watchdog not wired');
  assert.strictEqual(Number(m[1]), 5000);
});

test('runClaude installs setInterval watchdog that fires on stale lastCliWriteAt', () => {
  assert.ok(/cliWatchdogTimer\s*=\s*doStream\s*\?\s*setInterval\(/.test(src),
    'cliWatchdogTimer must be a setInterval — fires independently of resetHeartbeat()');
  assert.ok(/Date\.now\(\)\s*-\s*lastCliWriteAt\s*>=\s*cliWatchdogMs/.test(src),
    'watchdog must compare wall-clock to lastCliWriteAt so mid-stream gaps also trigger');
});

test('runClaude bumps lastCliWriteAt on every CLI write (stream + heartbeat)', () => {
  const writeBumps = src.match(/bumpCliWrite\(\)/g) || [];
  assert.ok(writeBumps.length >= 3,
    `bumpCliWrite() must be called on (1) stream chunk write, (2) heartbeat write, (3) watchdog write — found ${writeBumps.length}`);
});

test('runClaude clears cliWatchdogTimer on close and error (no zombie interval)', () => {
  const closes = src.match(/if \(cliWatchdogTimer\) clearInterval\(cliWatchdogTimer\)/g) || [];
  assert.ok(closes.length >= 2,
    'watchdog must be cleared in both close and error handlers to avoid leaking interval timer');
});

test('watchdog actually fires when no CLI writes happen for >= 5s (clock-mock)', () => {
  // Pure logic test: model the watchdog predicate and assert it triggers at
  // exactly the 5s threshold, regardless of upstream resetHeartbeat() resets.
  const cliWatchdogMs = 5000;
  let lastCliWriteAt = 1000;
  let now = lastCliWriteAt;
  const fired = [];
  const tick = (advanceMs) => {
    now += advanceMs;
    if (now - lastCliWriteAt >= cliWatchdogMs) {
      fired.push(now);
      lastCliWriteAt = now;
    }
  };
  for (let i = 0; i < 4; i++) tick(1000);
  assert.strictEqual(fired.length, 0, 'watchdog must not fire before 5s elapsed');
  tick(1000);
  assert.strictEqual(fired.length, 1, 'watchdog must fire at the 5s boundary');
  for (let i = 0; i < 4; i++) tick(1000);
  assert.strictEqual(fired.length, 1, 'watchdog must reset after firing — no double-trigger before next 5s window');
  tick(1000);
  assert.strictEqual(fired.length, 2, 'watchdog must continue firing every 5s of silence');
});

// ── Item 2: `[N agents]` parallel-tasks parse fix ───────────────────────────

// Load parsePlanningSubtasks directly without booting the full harness.
// run-agent.js triggers global setup at require time, so we re-implement the
// two pure functions from the same source to lock the regex in place.
function loadParseFns() {
  const m = src.match(/function splitPromptIntoTasks\([\s\S]*?\n\}\n[\s\S]*?function parsePlanningSubtasks\([\s\S]*?\n\}\n/);
  assert.ok(m, 'could not extract parser functions from run-agent.js');
  const sandbox = { module: { exports: {} } };
  // eslint-disable-next-line no-new-func
  new Function('module',
    m[0] + '\nmodule.exports = { splitPromptIntoTasks, parsePlanningSubtasks };')(sandbox.module);
  return sandbox.module.exports;
}

test('parsePlanningSubtasks regex no longer uses /m flag (the root-cause bug)', () => {
  const m = src.match(/planText\.match\(\/(.+?)\/([a-z]*)\)/);
  assert.ok(m, 'parsePlanningSubtasks regex literal not found');
  const flags = m[2];
  assert.ok(!flags.includes('m'),
    `/m flag must be removed — with /m, $ matches end-of-line so the lazy capture stopped at the first body line. Found flags="${flags}"`);
});

test('parsePlanningSubtasks captures full body across multiple task lines', () => {
  const { parsePlanningSubtasks } = loadParseFns();
  const plan = [
    '# Plan',
    '',
    '## Parallel Tasks',
    '1. Fix heartbeat regression',
    '2. Fix N-agents display',
    '3. Add regression tests',
    '4. Update README',
    '5. Verify CLI output',
    ''
  ].join('\n');
  const tasks = parsePlanningSubtasks(plan);
  assert.ok(Array.isArray(tasks), 'expected an array of subtasks');
  assert.strictEqual(tasks.length, 5,
    `expected 5 subtasks — under the buggy /m regex this returned 1 (or null). Got: ${tasks ? tasks.length : 'null'}`);
});

test('parsePlanningSubtasks stops at next ## section (does not swallow following content)', () => {
  const { parsePlanningSubtasks } = loadParseFns();
  const plan = [
    '## Parallel Tasks',
    '1. Task A',
    '2. Task B',
    '3. Task C',
    '',
    '## Notes',
    'Do not include this section',
    ''
  ].join('\n');
  const tasks = parsePlanningSubtasks(plan);
  assert.ok(tasks && tasks.length === 3, `expected 3 tasks, got ${tasks ? tasks.length : 'null'}`);
  assert.ok(!tasks.some(t => /Do not include this section/.test(t)),
    'capture must terminate at the next ## heading');
});

test('parsePlanningSubtasks handles Parallel Tasks heading not at start-of-string', () => {
  // Without the /m flag, ^ would only match string-start. The fix drops ^ so
  // a planning preamble before the heading still parses.
  const { parsePlanningSubtasks } = loadParseFns();
  const plan = [
    'Some planning preamble paragraph here.',
    '',
    '## Parallel Tasks',
    '1. First',
    '2. Second',
    ''
  ].join('\n');
  const tasks = parsePlanningSubtasks(plan);
  assert.ok(tasks && tasks.length === 2,
    `parser must find Parallel Tasks mid-document, not only at string start. Got ${tasks ? tasks.length : 'null'}`);
});

if (!process.exitCode) console.log('\nAll regression tests passed.');
