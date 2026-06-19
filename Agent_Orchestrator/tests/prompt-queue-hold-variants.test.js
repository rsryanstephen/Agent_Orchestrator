#!/usr/bin/env node
'use strict';

// Regression tests for prompt-queue hold-marker behaviour and hqregen safety.
// Run: node Agent_Orchestrator/tests/prompt-queue-hold-variants.test.js
//
// Covers (distinct from prompt-queue.test.js baseline):
//  (1)  dequeueFirstUnheld: unknown-shorthand in unheld block leaves queue untouched
//  (2)  dequeueFirstUnheld: all-held returns warning + skippedHeld count, queue byte-identical
//  (3)  dequeueFirstUnheld: skippedHeld count is correct across mixed held/unheld queue
//  (4)  dequeueFirstUnheld: held blocks retained in file, only unheld removed
//  (5)  dequeueFirstUnheld: null when file missing (matches dequeueHead parity)
//  (6)  hqregen (regenerate-queue.js) is documented as destructive in source comment
//  (7)  hqregen source warns caller about pending block loss before wiping
//  (8)  dequeueFirstUnheld: `block.body` strips hold line and returns clean prompt content
//  (9)  parseBlock: `(hold)` inline on `Pipeline:` header strips hold from pipeline parse
// (10)  unknown-shorthand path leaves queue file byte-identical (dequeueFirstUnheld)

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const promptQueue = require(path.join(HARNESS, 'src', 'prompt-queue.js'));
const regenSrc    = fs.readFileSync(path.join(HARNESS, 'src', 'regenerate-queue.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pq-hold-')); }
function writeQueue(dir, txt) {
  fs.writeFileSync(path.join(dir, 'prompt-queue.md'), txt, 'utf8');
}
function readQueue(dir) {
  return fs.readFileSync(path.join(dir, 'prompt-queue.md'), 'utf8');
}

// ── (1) unknown-shorthand in unheld block -> queue untouched ─────────────────
test('(1) dequeueFirstUnheld: unknown shorthand in unheld block leaves queue byte-identical', () => {
  const d = tmpdir();
  const initial = 'caf (hold)\nHeld first\n\n---\n\nPipeline: gibberish\nUnheld but unknown shorthand\n\n---\n\ncaf\nGood third block\n';
  writeQueue(d, initial);
  const warnings = [];
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: m => warnings.push(m) });
  assert.ok(r && r.block === null && r.warning === 'unknown-shorthand',
    'expected unknown-shorthand warning result');
  assert.strictEqual(readQueue(d), initial,
    'queue must be byte-identical after unknown-shorthand failure');
  assert.ok(warnings.some(w => /unknown shorthand/i.test(w)),
    'expected log warning about unknown shorthand');
});

// ── (2) all-held returns warning + queue byte-identical ───────────────────────
test('(2) dequeueFirstUnheld: all-held queue returns warning and leaves file byte-identical', () => {
  const d = tmpdir();
  const initial = 'caf (hold)\nBlock A\n\n---\n\npcaf\n(hold)\nBlock B\n\n---\n\nall (HOLD)\nBlock C\n';
  writeQueue(d, initial);
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.block === null && r.warning === 'all-held',
    'expected all-held warning when every block is held');
  assert.strictEqual(readQueue(d), initial,
    'queue file must be byte-identical when all blocks are held');
});

// ── (3) skippedHeld count correct ─────────────────────────────────────────────
test('(3) dequeueFirstUnheld: skippedHeld count reflects number of held blocks before picked', () => {
  const d = tmpdir();
  writeQueue(d,
    'caf (hold)\nFirst held\n\n---\n\npcaf\nhold\nSecond held via body\n\n---\n\ncaf\nThird unheld (picked)\n\n---\n\npcaf\nFourth\n');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.block, 'expected a block to be picked');
  assert.strictEqual(r.skippedHeld, 2, 'skippedHeld must equal 2 (both held blocks before the picked)');
  assert.strictEqual(r.block.pipeline, 'caf', 'must pick the first unheld block (caf)');
});

// ── (4) held blocks retained, only unheld removed ────────────────────────────
test('(4) dequeueFirstUnheld: held blocks remain in file after dequeue of unheld block', () => {
  const d = tmpdir();
  writeQueue(d, 'caf (hold)\nStay-held-A\n\n---\n\npcaf\nUnheld body to remove\n\n---\n\nall (hold)\nStay-held-B\n');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.block, 'expected a block to be dequeued');
  assert.ok(r.block.body.includes('Unheld body to remove'),
    'dequeued block body must be the unheld block');
  const after = readQueue(d);
  assert.ok(after.includes('Stay-held-A'), 'held block A must remain in queue file');
  assert.ok(after.includes('Stay-held-B'), 'held block B must remain in queue file');
  assert.ok(!after.includes('Unheld body to remove'), 'dequeued body must be removed from queue');
});

// ── (5) null on missing file ──────────────────────────────────────────────────
test('(5) dequeueFirstUnheld returns null when queue file is missing (parity with dequeueHead)', () => {
  const d = tmpdir();
  assert.strictEqual(promptQueue.dequeueFirstUnheld(d), null,
    'missing queue file must return null from dequeueFirstUnheld');
});

// ── (6) hqregen documented as destructive ────────────────────────────────────
test('(6) regenerate-queue.js source is documented as destructive', () => {
  assert.ok(/destructive/i.test(regenSrc),
    'regenerate-queue.js must document that the operation is destructive');
  assert.ok(/Wipes/i.test(regenSrc) || /wipes/i.test(regenSrc),
    'regenerate-queue.js must warn that pending blocks will be wiped');
});

// ── (7) hqregen source warns about pending block loss ────────────────────────
test('(7) regenerate-queue.js logs prior block count so user knows what was lost', () => {
  assert.ok(/priorCount/.test(regenSrc),
    'regenerate-queue.js must reference priorCount so it can be surfaced in the log');
  assert.ok(/wiped.*priorCount|priorCount.*wiped/i.test(regenSrc) ||
    /wiped \$\{r\.priorCount\}/.test(regenSrc),
    'regenerate-queue.js must log the number of prior blocks that were wiped');
});

// ── (8) dequeueFirstUnheld body strips the hold line ─────────────────────────
test('(8) dequeueFirstUnheld: body of dequeued block has hold line removed', () => {
  const d = tmpdir();
  writeQueue(d, 'caf (hold)\nHeld A\n\n---\n\npcaf\n(hold)\nReal prompt body here\n');
  // pcaf has a body-line hold — it is held and should be skipped.
  // No unheld block remains — all-held.
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.warning === 'all-held', 'expected all-held when both blocks are held');

  // Now test body-strip when the unheld block is picked.
  const d2 = tmpdir();
  writeQueue(d2, 'caf (hold)\nHeld\n\n---\n\npcaf\nReal prompt no hold line\n');
  const r2 = promptQueue.dequeueFirstUnheld(d2, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r2 && r2.block, 'expected block when second block is unheld');
  assert.ok(r2.block.body.includes('Real prompt no hold line'), 'body must be intact when no hold line');
  assert.ok(!r2.block.body.match(/^\s*\(hold\)\s*$/m), 'body must not contain hold line');
});

// ── (9) parseBlock: `(hold)` inline on `Pipeline:` strips hold, keeps pipeline ─
test('(9) parseBlock: `Pipeline: caf (hold)` strips (hold) and sets held=true, pipeline=caf', () => {
  const list = promptQueue.readShorthandList();
  const parsed = promptQueue.parseBlock('Pipeline: caf (hold)\nPrompt body text\n', list);
  assert.strictEqual(parsed.held, true, 'block must be held');
  assert.strictEqual(parsed.pipeline, 'caf', 'pipeline must be caf with (hold) stripped');
  assert.ok(parsed.body.includes('Prompt body text'), 'body must contain the actual prompt');
  assert.ok(!/\(hold\)/i.test(parsed.body.split('\n')[0]),
    'first body line must not contain the (hold) marker');
});

// ── (10) unknown-shorthand leaves queue byte-identical (dequeueFirstUnheld) ───
test('(10) dequeueFirstUnheld: remainingCount unchanged + file unchanged on unknown-shorthand', () => {
  const d = tmpdir();
  const initial = 'Pipeline: nosuchcmd\nPrompt that uses unknown shorthand\n\n---\n\ncaf\nNext prompt\n';
  writeQueue(d, initial);
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.warning === 'unknown-shorthand', 'expected unknown-shorthand warning');
  assert.strictEqual(r.remainingCount, 2, 'remainingCount must reflect full queue count');
  assert.strictEqual(readQueue(d), initial, 'queue file must be byte-identical after unknown-shorthand');
});

// ── (11) bare shorthand + inline hold: `pcaf (hold)` ────────────────────────
// Spec: "The header may also include a hold marker such as `Pipeline: caf (hold)`
// or `pcaf (hold)` to skip that block during dequeue and leave it in place."
test('(11) parseBlock: `pcaf (hold)` sets held=true and pipeline=pcaf', () => {
  const list = promptQueue.readShorthandList();
  const parsed = promptQueue.parseBlock('pcaf (hold)\nSpec-hold body\n', list);
  assert.strictEqual(parsed.held, true, 'pcaf (hold) must set held=true');
  assert.strictEqual(parsed.pipeline, 'pcaf', 'pipeline must be pcaf with (hold) stripped');
  assert.ok(parsed.body.includes('Spec-hold body'), 'body must contain the actual prompt');
  assert.ok(!/\(hold\)/i.test(parsed.body), 'body must not contain (hold) marker');
});

test('(11b) dequeueFirstUnheld: `pcaf (hold)` block skipped and left in file', () => {
  const d = tmpdir();
  writeQueue(d, 'pcaf (hold)\nHeld prompt\n\n---\n\ncaf\nUnheld prompt\n');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.block, 'expected unheld block to be dequeued');
  assert.strictEqual(r.skippedHeld, 1, 'must skip 1 held block (pcaf (hold))');
  assert.ok(r.block.body.includes('Unheld prompt'), 'dequeued block must be the unheld one');
  const after = readQueue(d);
  assert.ok(after.includes('Held prompt'), 'pcaf (hold) block body must remain in queue file');
  assert.ok(/pcaf\s*\(hold\)/i.test(after), 'pcaf (hold) header line itself must survive file rewrite');
  assert.ok(!after.includes('Unheld prompt'), 'dequeued block must be removed');
});

if (_failed === 0) console.log('\nAll prompt-queue-hold-variants tests passed.');
