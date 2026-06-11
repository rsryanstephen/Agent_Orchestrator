#!/usr/bin/env node
'use strict';

/**
 * Regression test for `promptQueue.regenerateQueueFile`.
 * Run: node Agent_Orchestrator/tests/queue-regenerate.test.js
 *
 * Covers:
 *  (1) wipes a populated queue and writes a fresh seed identical to ensureQueueFile output
 *  (2) priorCount reflects pre-wipe block count
 *  (3) no-op on missing file still seeds a fresh queue
 *  (4) lock file removed after operation
 *  (5) REPL command + shell alias wiring present
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const promptQueue = require(path.join(HARNESS, 'src', 'prompt-queue.js'));
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
const shellFnsRaw = fs.readFileSync(path.join(HARNESS, 'shell-functions.txt'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pq-regen-')); }

test('(1) regenerate wipes blocks and writes fresh seed identical to ensureQueueFile', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'prompt-queue.md'),
    'Pipeline: caf\nBlock A body\n\n---\n\npcaf\nBlock B body\n\n---\n\n(hold)\nBlock C body held\n',
    'utf8');
  const before = promptQueue.parseQueue(d);
  assert.strictEqual(before.blocks.length, 3);

  const r = promptQueue.regenerateQueueFile(d);
  assert.strictEqual(r.wiped, true, 'should report wiped=true');
  assert.strictEqual(r.priorCount, 3, 'priorCount should equal pre-wipe block count');

  const regenText = fs.readFileSync(r.file, 'utf8');

  const d2 = tmpdir();
  promptQueue.ensureQueueFile(d2);
  const freshText = fs.readFileSync(path.join(d2, 'prompt-queue.md'), 'utf8');

  assert.strictEqual(regenText, freshText, 'regenerated file must byte-match fresh ensureQueueFile output');

  // Post-regen queue contains only the seed (parsed = 0 user blocks).
  const after = promptQueue.parseQueue(d);
  assert.strictEqual(after.blocks.length, 0, 'after regen, no user blocks should parse');
});

test('(2) regenerate on missing file seeds a fresh queue with priorCount=0', () => {
  const d = tmpdir();
  const r = promptQueue.regenerateQueueFile(d);
  assert.strictEqual(r.wiped, false);
  assert.strictEqual(r.priorCount, 0);
  assert.ok(fs.existsSync(r.file), 'queue file should exist after regen');
});

test('(3) lock file is released after regenerate', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'prompt-queue.md'), 'foo\n', 'utf8');
  promptQueue.regenerateQueueFile(d);
  assert.ok(!fs.existsSync(path.join(d, 'prompt-queue.md.lock')), 'lock file must be removed');
});

test('(4) :queue-regen REPL handler wired in run-agent.js', () => {
  assert.ok(/':queue-regen'|':qregen'/.test(runAgentSrc), 'expected :queue-regen / :qregen sentinel in run-agent.js');
  assert.ok(/regenerateQueueFile\(/.test(runAgentSrc), 'expected promptQueue.regenerateQueueFile call in run-agent.js');
});

test('(5) hqregen shell function wired in shell-functions.txt', () => {
  assert.ok(/hqregen\(\)/.test(shellFnsRaw), 'expected hqregen() function in shell-functions.txt');
  assert.ok(/regenerate-queue\.js/.test(shellFnsRaw), 'expected regenerate-queue.js wired in shell-functions.txt');
});

test('(6) post-regen seed-only file -> dequeueFirstUnheld returns null (empty-prompt hrun falls back to interactive)', () => {
  // End-to-end invariant exercised by `fillEmptyPromptFromQueueOrInteractive`:
  // after a user runs `hqregen` the file contains ONLY the seed. The next
  // `hrun` with an empty prompt must NOT silently dequeue the seed header as
  // a prompt — it must fall through to the interactive multi-line reader.
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'prompt-queue.md'),
    'Pipeline: caf\nblock A\n\n---\n\npcaf\nblock B\n', 'utf8');
  const r = promptQueue.regenerateQueueFile(d);
  assert.strictEqual(r.priorCount, 2, 'priorCount counts only user blocks (seed excluded)');
  const popped = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.strictEqual(popped, null, 'seed-only file must yield null from dequeueFirstUnheld');
  // File still on disk -> next regen / next hrun finds the seed and re-prompts.
  assert.ok(fs.existsSync(r.file), 'seed file must remain after no-op dequeue');
});

test('(7) priorCount on pristine seed-only file is 0 (messaging not misleading)', () => {
  const d = tmpdir();
  promptQueue.ensureQueueFile(d);
  const r = promptQueue.regenerateQueueFile(d);
  assert.strictEqual(r.priorCount, 0, 'pristine seed-only regen must report 0 prior blocks');
});

if (_failed === 0) console.log('\nAll queue-regenerate tests passed.');
else { console.error(`\n${_failed} test(s) failed.`); process.exitCode = 1; }
