#!/usr/bin/env node
'use strict';

/**
 * Verifies recovery behaviour when `.last-topic` is in a corrupted state:
 * missing, empty, or whitespace-only. The CLI must NOT proceed with an empty
 * topic — it must die with an actionable message that names available topics
 * and instructs the user to re-select via `hset <topic>`.
 *
 * Strategy: spawn `node src/run-agent.js coding` (no topic arg) with a temp
 * harness state (corrupted .last-topic) and assert exit !=0 + stderr/stdout
 * contains the recovery prompt and does NOT proceed to dispatch.
 *
 * Run: node Agent_Orchestrator/tests/last-topic-corruption-recovery.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const LAST_TOPIC = path.join(HARNESS, '.last-topic');
const BACKUP = LAST_TOPIC + '.recoverytest.bak';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// Preserve any existing .last-topic so the test does not clobber the user's
// active topic when run locally.
let hadOriginal = false;
if (fs.existsSync(LAST_TOPIC)) {
  fs.copyFileSync(LAST_TOPIC, BACKUP);
  hadOriginal = true;
}

function runWithoutTopic() {
  return spawnSync(process.execPath, [RUN_AGENT, 'coding'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 15000,
  });
}

test('LTC1 — empty .last-topic -> non-zero exit + recovery message, no dispatch', () => {
  fs.writeFileSync(LAST_TOPIC, '', 'utf8');
  const r = runWithoutTopic();
  const blob = (r.stdout || '') + '\n' + (r.stderr || '');
  assert.notStrictEqual(r.status, 0, 'expected non-zero exit for empty .last-topic');
  assert.ok(/No active topic|\.last-topic.*empty|hset/i.test(blob), `expected recovery message, got:\n${blob.slice(0, 500)}`);
  // Must NOT have proceeded to phase dispatch.
  assert.ok(!/--- Phase:/.test(blob), 'must not dispatch any phase when topic is empty');
});

test('LTC2 — whitespace-only .last-topic -> same recovery path', () => {
  fs.writeFileSync(LAST_TOPIC, '   \n\t ', 'utf8');
  const r = runWithoutTopic();
  const blob = (r.stdout || '') + '\n' + (r.stderr || '');
  assert.notStrictEqual(r.status, 0);
  assert.ok(/No active topic|empty|hset/i.test(blob), `expected recovery message, got:\n${blob.slice(0, 500)}`);
  assert.ok(!/--- Phase:/.test(blob));
});

test('LTC3 — missing .last-topic -> recovery message', () => {
  try { fs.unlinkSync(LAST_TOPIC); } catch {}
  const r = runWithoutTopic();
  const blob = (r.stdout || '') + '\n' + (r.stderr || '');
  assert.notStrictEqual(r.status, 0);
  assert.ok(/No active topic|hset|topic first/i.test(blob), `expected recovery message, got:\n${blob.slice(0, 500)}`);
});

// Restore
if (hadOriginal) {
  fs.copyFileSync(BACKUP, LAST_TOPIC);
  try { fs.unlinkSync(BACKUP); } catch {}
} else {
  try { fs.unlinkSync(LAST_TOPIC); } catch {}
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
