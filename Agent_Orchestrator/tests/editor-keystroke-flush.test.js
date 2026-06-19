#!/usr/bin/env node
'use strict';

// The buffer flush is keystroke-only and non-configurable. flushViaKeystroke
// focuses the running editor window and sends the Save-All chord via PowerShell +
// .NET SendKeys. The chord defaults to the VS Code Save-All `^(k)s` (and is
// auto-detected from keybindings.json when present); the window-match regex is a
// hardcoded constant. Asserts the PowerShell argv the module passes to spawnSync.
//
// Behavioral: forces process.platform to win32 and stubs child_process.spawnSync
// BEFORE requiring editor-buffer-flush.js (it destructures spawnSync at load). The
// editor-detect probe and the focus/SendKeys script are both spawnSync calls; the
// LAST recorded call is the focus script carrying the chord.
//
// Run: node Agent_Orchestrator/tests/editor-keystroke-flush.test.js

const path = require('path');
const assert = require('assert');

// flushViaKeystroke is Windows-only; force win32 so the test is platform-stable.
Object.defineProperty(process, 'platform', { value: 'win32' });

const cp = require('child_process');
let lastCall = null;
// Detect probe returns no stdout -> resolveSaveAllChord falls back to ^(k)s.
cp.spawnSync = function (bin, args, opts) {
  lastCall = { bin, args: args || [], opts: opts || {} };
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
  lastCall = null;
  flushEditorBuffers();
  return lastCall;
}

test('flush spawns PowerShell (keystroke flush) with windowsHide', () => {
  const c = runFlush();
  assert.ok(c, 'spawnSync must be invoked');
  assert.strictEqual(c.bin, 'powershell', 'keystroke flush must spawn powershell');
  assert.ok(c.args.includes('-Command'), 'must pass -Command');
  assert.strictEqual(c.opts.windowsHide, true, 'must suppress the console window');
});

test('focus script carries the hardcoded window-match regex', () => {
  const c = runFlush();
  const script = c.args[c.args.length - 1];
  assert.ok(/code\|cursor\|codium\|devenv\|sublime_text\|idea64\|rider64/.test(script),
    'script must carry the hardcoded window-match regex');
  assert.ok(/SendKeys\]::SendWait/.test(script), 'script must send the chord via SendKeys');
});

test('default chord is the VS Code Save-All ^(k)s (no keybindings override)', () => {
  const c = runFlush();
  const script = c.args[c.args.length - 1];
  assert.ok(/\$keys='\^\(k\)s'/.test(script), `default chord must be ^(k)s; got: ${script}`);
});

test('hardcoded keystroke spawn timeout is 8000ms', () => {
  const c = runFlush();
  assert.strictEqual(c.opts.timeout, 8000, 'keystroke spawn timeout must be the hardcoded 8000ms');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
