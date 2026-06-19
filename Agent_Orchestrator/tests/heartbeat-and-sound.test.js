#!/usr/bin/env node
'use strict';

// Regression tests for:
//  1. Aggregate fleet heartbeat (5s cadence, in-process counter, suppressed under reminder beep).
//  2. Pre-spawn heartbeat coverage of the `fix` (remediation) phase via `runClaude`.
//  3. Default `notification-sound-file` reverted to Windows `chimes.wav`.
// Run: node Agent_Orchestrator/tests/heartbeat-and-sound.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const GLOBAL = path.join(HARNESS, 'global-config.json');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

const src = fs.readFileSync(RUN_AGENT, 'utf8');

test('global-config.json default notification-sound-file is Windows chimes.wav', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  assert.strictEqual(cfg['notification-sound-file'], 'C:\\Windows\\Media\\chimes.wav');
});

test('playNotificationSound clarifying fallback default is Windows Notify Calendar.wav', () => {
  const m = src.match(/cfgRead\(topicConfig,\s*config,\s*'clarifying-sound-file',\s*'([^']+)'\)/);
  assert.ok(m, 'cfgRead call for clarifying-sound-file not found');
  assert.strictEqual(m[1], 'C:\\\\Windows\\\\Media\\\\Windows Notify Calendar.wav');
});

test('bundled assets/notification.wav retained for opt-in', () => {
  assert.ok(fs.existsSync(path.join(HARNESS, 'assets', 'notification.wav')),
    'bundled chime should remain in-repo as opt-in fallback');
});

test('runFleet emits aggregate heartbeat, not per-child still-working', () => {
  const fnMatch = src.match(/async function runFleet\([\s\S]*?\n\}\n/);
  assert.ok(fnMatch, 'runFleet not found');
  const body = fnMatch[0];
  assert.ok(/agent\(s\)\] working… topics:/.test(body),
    'aggregate heartbeat line missing from runFleet');
  assert.ok(!/\[\$\{label\}\] still working/.test(body),
    'runFleet must not emit per-child still-working lines');
});

test('runFleet heartbeat fires at 5s cadence (prespawnHeartbeatMs)', () => {
  const fnMatch = src.match(/async function runFleet\([\s\S]*?\n\}\n/);
  const body = fnMatch[0];
  assert.ok(/prespawnHeartbeatMs/.test(body),
    'runFleet should drive heartbeat from prespawnHeartbeatMs (5s), not streamingHeartbeatMs (15s)');
});

test('runFleet uses in-process counter with try/finally decrement', () => {
  const fnMatch = src.match(/async function runFleet\([\s\S]*?\n\}\n/);
  const body = fnMatch[0];
  assert.ok(/let liveCount = subtasks\.length/.test(body),
    'liveCount must initialize synchronously to subtasks.length so first 5s tick reflects true fleet size (no microtask-ordering race)');
  assert.ok(/finally\s*\{\s*liveCount--/.test(body),
    'liveCount must decrement inside try/finally so crashed children still tick down');
});

test('runFleet suppresses heartbeat when liveCount is 0', () => {
  const fnMatch = src.match(/async function runFleet\([\s\S]*?\n\}\n/);
  const body = fnMatch[0];
  assert.ok(/if \(liveCount <= 0\) return/.test(body),
    'no blank "[0 agents]" line when fleet is idle');
});

test('runFleet suppresses heartbeat during clarifying-question wait', () => {
  const fnMatch = src.match(/async function runFleet\([\s\S]*?\n\}\n/);
  const body = fnMatch[0];
  assert.ok(/if \(_reminderInterval\) return/.test(body),
    'fleet heartbeat must not interleave with reminder beep + readline prompt');
});

test('runClaude pre-spawn heartbeat default is 5s', () => {
  const m = src.match(/prespawnHeartbeatMs = config\.prespawnHeartbeatMs \|\| (\d+)/);
  assert.ok(m, 'prespawnHeartbeatMs default not found');
  assert.strictEqual(Number(m[1]), 5000);
});

test('runCodingAssessment (fix/remediation) routes through runClaude wrapper', () => {
  const m = src.match(/async function runCodingAssessment\([\s\S]*?\n\}\n/);
  assert.ok(m, 'runCodingAssessment not found');
  const body = m[0];
  assert.ok(/await runClaude\(payload,\s*\{[^}]*label:\s*'coding-agent'[^}]*role:\s*'coding'/.test(body),
    'fix-phase remediation must call runClaude so the 5s pre-spawn heartbeat covers it');
  assert.ok(!/silent:\s*true/.test(body),
    'serial remediation must not silence runClaude — heartbeat fires only when doStream=true');
});

test('runCodingAssessmentParallel (fix-parallel) routes through runFleet wrapper', () => {
  const m = src.match(/async function runCodingAssessmentParallel\([\s\S]*?\n\}\n/);
  assert.ok(m, 'runCodingAssessmentParallel not found');
  const body = m[0];
  assert.ok(/await runFleet\(/.test(body),
    'parallel fix must dispatch through runFleet so aggregate heartbeat covers it');
});

test('inline // comment for notification-sound-file mentions Windows default + alt path', () => {
  const raw = fs.readFileSync(GLOBAL, 'utf8');
  const m = raw.match(/"\/\/ notification-sound-file":\s*"([^"]*)"/);
  assert.ok(m, 'inline comment for notification-sound-file missing');
  assert.ok(/chimes\.wav/i.test(m[1]), 'comment should name the Windows chimes.wav default');
  assert.ok(/assets\/notification\.wav/.test(m[1]), 'comment should name the alt bundled chime path');
});

if (!process.exitCode) console.log('\nAll regression tests passed.');
