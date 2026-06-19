#!/usr/bin/env node
'use strict';

// Regression tests for the standalone hold marker feature in prompt-queue.js.
// Spec: the user may type `(hold)` or `hold` (any HOLD_LINE_RE form) as the
// FIRST non-blank line of a queued block to skip it during dequeue — no
// Pipeline: header or shorthand token required. These tests cover parseBlock
// and the dequeueFirstUnheld integration path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const pq = require(path.join(HARNESS, 'src', 'prompt-queue.js'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pq-hold-')); }
function writeQueue(d, txt) { fs.writeFileSync(path.join(d, 'prompt-queue.md'), txt, 'utf8'); }
function readQueue(d) { try { return fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8'); } catch { return ''; } }

const shorthandList = pq.readShorthandList();

// ── parseBlock: standalone (hold) — no header token ──────────────────────────

test('standalone `(hold)` as first line -> held=true, no header, body preserved', () => {
  const r = pq.parseBlock('(hold)\nDo the thing', shorthandList);
  assert.strictEqual(r.held, true);
  assert.strictEqual(r.headerForm, null);
  assert.strictEqual(r.pipeline, null);
  assert.ok(r.body.includes('Do the thing'));
  assert.ok(!/hold/i.test(r.body));
});

test('standalone bare `hold` as first line -> held=true, no header, body preserved', () => {
  const r = pq.parseBlock('hold\nDo the thing', shorthandList);
  assert.strictEqual(r.held, true);
  assert.strictEqual(r.headerForm, null);
  assert.strictEqual(r.pipeline, null);
  assert.ok(r.body.includes('Do the thing'));
  assert.ok(!/\bhold\b/i.test(r.body));
});

test('standalone `(hold)` alone (no body) -> held=true, empty body', () => {
  const r = pq.parseBlock('(hold)', shorthandList);
  assert.strictEqual(r.held, true);
  assert.strictEqual(r.body.trim(), '');
});

test('standalone `hold` alone (no body) -> held=true, empty body', () => {
  const r = pq.parseBlock('hold', shorthandList);
  assert.strictEqual(r.held, true);
  assert.strictEqual(r.body.trim(), '');
});

test('standalone `[hold]` (bracket form) -> held=true', () => {
  const r = pq.parseBlock('[hold]\nSome work', shorthandList);
  assert.strictEqual(r.held, true);
  assert.ok(r.body.includes('Some work'));
});

test('standalone `<HOLD>` (angle-bracket form, uppercase) -> held=true', () => {
  const r = pq.parseBlock('<HOLD>\nSome work', shorthandList);
  assert.strictEqual(r.held, true);
  assert.ok(r.body.includes('Some work'));
});

test('standalone `  (hold)  ` (whitespace-padded) -> held=true', () => {
  const r = pq.parseBlock('  (hold)  \nSome work', shorthandList);
  assert.strictEqual(r.held, true);
  assert.ok(r.body.includes('Some work'));
});

test('mid-body `hold` NOT treated as hold marker (only first non-blank counts)', () => {
  const r = pq.parseBlock('First real line\nhold\nMore body', shorthandList);
  assert.strictEqual(r.held, false);
  // The word `hold` must remain in the body since it was mid-body
  assert.ok(r.body.includes('hold'));
});

test('blank lines before standalone `(hold)` still trigger body hold', () => {
  const r = pq.parseBlock('\n\n(hold)\nActual body', shorthandList);
  assert.strictEqual(r.held, true);
  assert.ok(r.body.includes('Actual body'));
});

// ── dequeueFirstUnheld: standalone hold blocks are skipped and left in file ──

test('dequeueFirstUnheld: standalone `(hold)` block is skipped, remains in file', () => {
  const d = tmpdir();
  writeQueue(d, '(hold)\nDo not dispatch yet\n\n---\n\ncaf\nDo dispatch this\n');
  const result = pq.dequeueFirstUnheld(d, { defaultPipeline: 'caf' });
  assert.ok(result, 'dequeueFirstUnheld must return a result');
  assert.ok(result.block, 'a runnable block must be found');
  assert.ok(result.block.body.includes('Do dispatch this'));
  assert.strictEqual(result.skippedHeld, 1);
  const remaining = readQueue(d);
  assert.ok(remaining.includes('Do not dispatch yet'), 'held block must remain in file');
  assert.ok(!remaining.includes('Do dispatch this'), 'dispatched block must be removed');
});

test('dequeueFirstUnheld: standalone bare `hold` block is skipped, remains in file', () => {
  const d = tmpdir();
  writeQueue(d, 'hold\nDo not dispatch yet\n\n---\n\ncaf\nDo dispatch this\n');
  const result = pq.dequeueFirstUnheld(d, { defaultPipeline: 'caf' });
  assert.ok(result && result.block, 'runnable block must be found');
  assert.ok(result.block.body.includes('Do dispatch this'));
  assert.strictEqual(result.skippedHeld, 1);
  const remaining = readQueue(d);
  assert.ok(remaining.includes('Do not dispatch yet'), 'held block must remain in file');
});

test('dequeueFirstUnheld: all standalone-hold blocks -> returns all-held warning', () => {
  const d = tmpdir();
  writeQueue(d, '(hold)\nBlock A\n\n---\n\nhold\nBlock B\n');
  const result = pq.dequeueFirstUnheld(d, { defaultPipeline: 'caf' });
  assert.ok(result, 'must return result object, not null');
  assert.strictEqual(result.block, null);
  assert.strictEqual(result.warning, 'all-held');
  assert.strictEqual(result.skippedHeld, 2);
  // Both blocks must remain in the file
  const remaining = readQueue(d);
  assert.ok(remaining.includes('Block A'), 'held Block A must remain');
  assert.ok(remaining.includes('Block B'), 'held Block B must remain');
});

test('dequeueFirstUnheld: standalone hold preserves hold marker in file on skip', () => {
  const d = tmpdir();
  writeQueue(d, '(hold)\nWaiting prompt\n\n---\n\ncaf\nGo now\n');
  pq.dequeueFirstUnheld(d, { defaultPipeline: 'caf' });
  const remaining = readQueue(d);
  // The hold marker itself must still be present so the block stays held
  assert.ok(/\(hold\)/i.test(remaining) || /^\s*hold\s*$/im.test(remaining),
    'hold marker must survive the rewrite so the block stays held on next dequeue');
});

if (_failed === 0) console.log('\nAll standalone-hold tests passed.');
else { console.error(`\n${_failed} test(s) FAILED.`); process.exit(1); }
