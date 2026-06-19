#!/usr/bin/env node
'use strict';

// Contract (was: configurable `editor-save-flush-timeout-ms`): the keystroke-flush
// spawn timeout is now a hardcoded, non-configurable 8000ms constant
// (KEYSTROKE_TIMEOUT). This test asserts the timeout the module actually passes to
// spawnSync, regardless of any config.
//
// Behavioral: stubs child_process.spawnSync BEFORE requiring editor-buffer-flush.js
// and forces win32 so the keystroke path runs.
//
// Run: node Agent_Orchestrator/tests/editor-save-flush-timeout-configurable.test.js

const path = require('path');
const assert = require('assert');

Object.defineProperty(process, 'platform', { value: 'win32' });

const cp = require('child_process');
let lastOpts = null;
cp.spawnSync = function (bin, args, opts) {
  lastOpts = opts || {};
  return { status: 0, error: null, stdout: '', stderr: '' };
};

const FLUSH = path.join(__dirname, '..', 'src', 'editor-buffer-flush.js');
const { flushEditorBuffers } = require(FLUSH);

const FLUSHED_ENV = 'HARNESS_EDITOR_FLUSHED';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e && (e.message || e)}`); }
}

function runFlush() {
  delete process.env[FLUSHED_ENV];
  lastOpts = null;
  flushEditorBuffers();
  return lastOpts;
}

test('keystroke flush passes the hardcoded 8000ms spawn timeout', () => {
  const opts = runFlush();
  assert.ok(opts, 'spawnSync must have been invoked');
  assert.strictEqual(opts.timeout, 8000, 'spawn timeout must equal the hardcoded 8000ms');
});

test('timeout is stable across calls (non-configurable)', () => {
  assert.strictEqual(runFlush().timeout, 8000);
  assert.strictEqual(runFlush().timeout, 8000);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
