#!/usr/bin/env node
'use strict';

/**
 * Regression: prompt-queue MUST re-read from disk at drain time.
 *
 * Scenario: a pipeline is mid-run when the user edits + saves
 * `prompt-queue.md` (replacing a held block with an unheld one). When the
 * pipeline finishes and `dequeueFirstUnheld` runs at end-of-pipeline drain,
 * it must dispatch the NEW unheld block — not the original held block that
 * existed when the pipeline started.
 *
 * Run: node Agent_Orchestrator/tests/queue-reread-on-drain.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const promptQueue = require(path.join(HARNESS, 'src', 'prompt-queue.js'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pq-reread-')); }
function writeQueue(dir, txt) { fs.writeFileSync(path.join(dir, 'prompt-queue.md'), txt, 'utf8'); }

test('(R1) dequeueFirstUnheld re-reads disk — mid-run rewrite is honoured', () => {
  const d = tmpdir();
  // (a) seed with 1 held block.
  writeQueue(d, 'Pipeline: caf (hold)\nHeld original prompt.\n');
  let res = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.strictEqual(res.block, null, 'initial held block must not be dispatched');
  assert.strictEqual(res.warning, 'all-held');

  // (b) simulate a fake pipeline phase that rewrites the queue file with 1
  //     unheld block, mid-run (after the original parse, before final drain).
  writeQueue(d, 'Pipeline: caf\nFresh unheld prompt added mid-run.\n');

  // (c) end-of-pipeline drain — MUST pick up the new unheld block.
  res = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(res && res.block, 'fresh unheld block must be dispatched');
  assert.strictEqual(res.block.pipeline, 'caf');
  assert.ok(res.block.body.includes('Fresh unheld prompt added mid-run.'),
    `body should contain the new prompt, got: ${JSON.stringify(res.block.body)}`);
});

test('(R2) queueLength + parseQueue read fresh from disk on every call', () => {
  const d = tmpdir();
  writeQueue(d, 'Pipeline: caf\nFirst.\n');
  assert.strictEqual(promptQueue.queueLength(d), 1);
  writeQueue(d, 'Pipeline: caf\nFirst.\n\n---\n\nPipeline: caf\nSecond.\n');
  assert.strictEqual(promptQueue.queueLength(d), 2, 'second call must observe edited file');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 2);
  assert.ok(blocks[1].body.includes('Second.'));
});

test('(R3) prompt-queue.js documents the disk-is-truth contract', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'prompt-queue.js'), 'utf8');
  assert.ok(/DISK IS THE ONLY SOURCE OF TRUTH/i.test(src),
    'expected disk-is-truth contract banner in prompt-queue.js header');
  assert.ok(/MUST NOT capture/.test(src),
    'expected explicit "callers must not capture parsed snapshots across awaits" note');
});

test('(R4) run-agent dequeueAndTriggerNext emits forensic stat + drain re-read log', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(/queue-file-stat/.test(src), 'expected queue-file-stat forensic log line');
  assert.ok(/head200Sha1=/.test(src), 'expected SHA-1 of first 200 bytes in forensic log');
  assert.ok(/re-read from disk at drain/.test(src), 'expected user-visible drain re-read log line');
});

if (_failed) process.exit(1);
