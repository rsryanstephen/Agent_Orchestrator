#!/usr/bin/env node
'use strict';

// The buffer flush is now keystroke-only and editor-agnostic — no spawn-command
// override, no `--reuse-window` injection. The Save-All chord defaults to the VS
// Code `^(k)s` (auto-detected from keybindings.json when present). This test asserts:
//   1. No `--reuse-window` injection logic remains in run-agent.js flushEditorBuffers.
//   2. The back-compat alias `saveAllVsCodeBuffers` still points to flushEditorBuffers.
//   3. The default resolved chord (no keybindings override) is `^(k)s`.
//
//   node Agent_Orchestrator/tests/saveAllVsCodeBuffers.reuse-window.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const FLUSH = path.join(HARNESS, 'src', 'editor-buffer-flush.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');
const { resolveSaveAllChord } = require(FLUSH);

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('flushEditorBuffers does NOT inject --reuse-window (editor-agnostic)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'flushEditorBuffers block found');
  assert.ok(!/--reuse-window/.test(fn[0]),
    'no --reuse-window injection must remain (editor-agnostic keystroke flush)');
});

test('flushEditorBuffers no longer spawns an external editor CLI (delegates to keystroke)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'flushEditorBuffers block found');
  assert.ok(/flushViaKeystroke\(\)/.test(fn[0]), 'must delegate to flushViaKeystroke()');
  assert.ok(!/spawnSync\(/.test(fn[0]), 'must not spawn an editor CLI directly');
});

test('back-compat alias saveAllVsCodeBuffers still exists and points to flushEditorBuffers', () => {
  assert.ok(/const\s+saveAllVsCodeBuffers\s*=\s*flushEditorBuffers/.test(src),
    'expected `const saveAllVsCodeBuffers = flushEditorBuffers;` alias for back-compat');
});

test('default resolved chord (no override) is the VS Code Save-All ^(k)s', () => {
  // procName null -> no keybindings file -> fallback chord.
  assert.strictEqual(resolveSaveAllChord({ procName: null }), '^(k)s');
});

console.log('done');
