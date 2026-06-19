#!/usr/bin/env node
'use strict';

// Regression: both queue-drain entry points must force a save-all editor flush
// (bypassing the once-per-run throttle) and settle BEFORE re-reading the queue,
// so a half-saved prompt buffer is not dequeued in truncated (first-line-only)
// form. Source-string assertions — the drain functions are not exported.
//
// Run: node Agent_Orchestrator/tests/drain-forces-editor-flush-before-queue-read.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RUN_AGENT = path.join(__dirname, '..', 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, '\n', e.stack || e.message); }
}

// Slice from a function's declaration to the start of the next top-level
// function declaration. Avoids brace-matching (the source has template-literal
// and destructured-param braces that miscount) — we only need statement
// ordering within the function, not an exact body.
function bodyOf(decl) {
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `declaration not found: ${decl}`);
  const after = start + decl.length;
  const nextRe = /\n(?:async\s+)?function\s/g;
  nextRe.lastIndex = after;
  const m = nextRe.exec(src);
  const end = m ? m.index : src.length;
  return src.slice(start, end);
}

test('_drainFlushEditorBuffers resets throttle, force-flushes, then sleeps', () => {
  const body = bodyOf('function _drainFlushEditorBuffers(');
  const reset = body.indexOf('_resetEditorFlushThrottle()');
  const flush = body.indexOf('flushEditorBuffers({ force: true })');
  const sleep = body.indexOf('sleepMs(');
  assert.ok(reset >= 0, 'must call _resetEditorFlushThrottle()');
  assert.ok(flush >= 0, 'must call flushEditorBuffers({ force: true })');
  assert.ok(sleep >= 0, 'must settle via sleepMs');
  assert.ok(reset < flush && flush < sleep, 'order must be reset -> flush -> sleep');
  assert.ok(/sleepMs\(\s*200\s*\)/.test(body), 'settle duration must be the hardcoded 200ms (non-configurable)');
});

for (const fn of ['fillEmptyPromptFromQueueOrInteractive', 'dequeueAndTriggerNext']) {
  test(`${fn} flushes editor buffers before any queue read`, () => {
    const body = bodyOf(`async function ${fn}(`);
    const drain = body.indexOf('_drainFlushEditorBuffers()');
    const parse = body.indexOf('parseQueue');
    const deq = body.indexOf('dequeueFirstUnheld');
    assert.ok(drain >= 0, 'must call _drainFlushEditorBuffers()');
    const firstRead = Math.min(
      parse >= 0 ? parse : Infinity,
      deq >= 0 ? deq : Infinity
    );
    assert.ok(firstRead !== Infinity, 'expected a parseQueue/dequeueFirstUnheld read');
    assert.ok(drain < firstRead, 'flush must precede the first queue read');
  });
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
