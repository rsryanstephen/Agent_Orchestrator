#!/usr/bin/env node
'use strict';

// Regression: the keystroke flush must pass `windowsHide: true` to EVERY spawnSync
// call (the editor-detect probe and the focus/SendKeys script) so the transient
// PowerShell console does not register in the Windows taskbar and flash. The flush
// now lives entirely in editor-buffer-flush.js (run-agent.js delegates to it).
//
//   node Agent_Orchestrator/tests/saveAllVsCodeBuffers.windowsHide.test.js

const path = require('path');
const assert = require('assert');

Object.defineProperty(process, 'platform', { value: 'win32' });

const cp = require('child_process');
const calls = [];
cp.spawnSync = function (bin, args, opts) {
  calls.push({ bin, args: args || [], opts: opts || {} });
  return { status: 0, error: null, stdout: '', stderr: '' };
};

const FLUSH = path.join(__dirname, '..', 'src', 'editor-buffer-flush.js');
const { flushEditorBuffers } = require(FLUSH);
const FLUSHED_ENV = 'HARNESS_EDITOR_FLUSHED';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${e && (e.message || e)}`); }
}

delete process.env[FLUSHED_ENV];
calls.length = 0;
flushEditorBuffers();

test('keystroke flush invoked spawnSync at least once', () => {
  assert.ok(calls.length >= 1, 'expected at least one spawnSync call from the keystroke flush');
});

test('every spawnSync call passes windowsHide: true', () => {
  for (const c of calls) {
    assert.strictEqual(c.opts.windowsHide, true,
      `spawnSync missing windowsHide: true -> ${c.bin}`);
  }
});

test('every spawnSync call targets powershell (no external editor CLI spawn)', () => {
  for (const c of calls) {
    assert.strictEqual(c.bin, 'powershell', 'flush must only spawn powershell now');
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
