#!/usr/bin/env node
'use strict';

// Spec-verification tests for the basic pipeline-selection rule:
//   - `Pipeline: <name>` on first non-blank line selects that pipeline.
//   - Bare shorthand (e.g. `pcaf`, `caf`) on first non-blank line selects that pipeline.
//   - No recognised header on first non-blank line → pipeline=null; dequeue uses defaultPipeline.
//
// These tests are deliberately narrow so the spec contract is explicit and
// does NOT rely on the model/provider token tests in prompt-queue-header-tokens.test.js.

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
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pq-spec-')); }
function writeQueue(d, txt) { fs.writeFileSync(path.join(d, 'prompt-queue.md'), txt, 'utf8'); }

// ── Pipeline: form ────────────────────────────────────────────────────────────

test('`Pipeline: caf` alone → pipeline=caf, model=null, body preserved', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('Pipeline: caf\nDo the thing\n', list);
  assert.strictEqual(r.pipeline, 'caf');
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.provider, null);
  assert.strictEqual(r.headerForm, 'pipeline-key');
  assert.ok(r.body.trim() === 'Do the thing');
});

test('`Pipeline: pcaf` alone → pipeline=pcaf, model=null, body preserved', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('Pipeline: pcaf\nRefactor widget cache\n', list);
  assert.strictEqual(r.pipeline, 'pcaf');
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.provider, null);
  assert.strictEqual(r.headerForm, 'pipeline-key');
  assert.ok(r.body.trim() === 'Refactor widget cache');
});

test('`Pipeline:` is case-insensitive (`PIPELINE: caf`) → pipeline=caf', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('PIPELINE: caf\nBody\n', list);
  assert.strictEqual(r.pipeline, 'caf');
  assert.strictEqual(r.headerForm, 'pipeline-key');
});

test('`Pipeline: all` → pipeline=all (default shorthand)', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('Pipeline: all\nBody\n', list);
  assert.strictEqual(r.pipeline, 'all');
  assert.strictEqual(r.headerForm, 'pipeline-key');
});

// ── Bare shorthand form ───────────────────────────────────────────────────────

test('`pcaf` bare on first non-blank line → pipeline=pcaf', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('pcaf\nRefactor widget cache\n', list);
  assert.strictEqual(r.pipeline, 'pcaf');
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.provider, null);
  assert.strictEqual(r.headerForm, 'bare');
  assert.ok(r.body.trim() === 'Refactor widget cache');
});

test('`caf` bare on first non-blank line → pipeline=caf', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('caf\nBody text\n', list);
  assert.strictEqual(r.pipeline, 'caf');
  assert.strictEqual(r.headerForm, 'bare');
  assert.ok(r.body.trim() === 'Body text');
});

test('`all` bare on first non-blank line → pipeline=all', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('all\nBody\n', list);
  assert.strictEqual(r.pipeline, 'all');
  assert.strictEqual(r.headerForm, 'bare');
});

test('bare shorthand `cont` → pipeline=cont', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('cont\nBody\n', list);
  assert.strictEqual(r.pipeline, 'cont');
  assert.strictEqual(r.headerForm, 'bare');
});

// ── No header → pipeline=null ─────────────────────────────────────────────────

test('no header (prompt text first line) → pipeline=null, body is full block', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('Add the foo feature to the widget service.\nMore detail.\n', list);
  assert.strictEqual(r.pipeline, null);
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.provider, null);
  assert.strictEqual(r.headerForm, null);
  assert.ok(r.body.includes('Add the foo feature'));
});

test('blank lines before body (no header) → pipeline=null, body includes content', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('\n\nJust a plain prompt\n', list);
  assert.strictEqual(r.pipeline, null);
  assert.ok(r.body.includes('Just a plain prompt'));
});

// ── Default pipeline applied at dequeue time ──────────────────────────────────

test('dequeueHead: no header in block → defaultedPipeline=true, pipeline set to defaultPipeline', () => {
  const d = tmpdir();
  writeQueue(d, 'Plain prompt text, no header\n');
  const result = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(result !== null, 'expected a block to be dequeued');
  assert.ok(result.block !== null, 'block should not be null (no unknown shorthand)');
  assert.strictEqual(result.defaultedPipeline, true, 'should report default was used');
  assert.strictEqual(result.block.pipeline, 'all', 'pipeline must match defaultPipeline');
});

test('dequeueHead: `Pipeline: caf` header → defaultedPipeline=false, pipeline=caf', () => {
  const d = tmpdir();
  writeQueue(d, 'Pipeline: caf\nAdd feature\n');
  const result = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(result !== null && result.block !== null);
  assert.strictEqual(result.defaultedPipeline, false);
  assert.strictEqual(result.block.pipeline, 'caf');
});

test('dequeueHead: `pcaf` bare header → defaultedPipeline=false, pipeline=pcaf', () => {
  const d = tmpdir();
  writeQueue(d, 'pcaf\nRefactor cache\n');
  const result = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(result !== null && result.block !== null);
  assert.strictEqual(result.defaultedPipeline, false);
  assert.strictEqual(result.block.pipeline, 'pcaf');
});

test('dequeueFirstUnheld: no header → defaultedPipeline=true, pipeline=all', () => {
  const d = tmpdir();
  writeQueue(d, 'Plain prompt text\n');
  const result = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(result !== null && result.block !== null);
  assert.strictEqual(result.defaultedPipeline, true);
  assert.strictEqual(result.block.pipeline, 'all');
});

// ── Multi-block queue: header applies only to its block ───────────────────────

test('multi-block: each block carries its own pipeline header independently', () => {
  const d = tmpdir();
  writeQueue(d, [
    'Pipeline: caf',
    'First prompt',
    '',
    '---',
    '',
    'pcaf',
    'Second prompt',
    '',
    '---',
    '',
    'Third prompt no header',
    '',
  ].join('\n'));
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[1].pipeline, 'pcaf');
  assert.strictEqual(blocks[2].pipeline, null, 'no header → null pipeline');
});

if (_failed === 0) console.log('\nAll pipeline-spec tests passed.');
else { console.error(`\n${_failed} test(s) FAILED.`); process.exit(1); }
