#!/usr/bin/env node
'use strict';

// Contract: the editor buffer flush is now hardcoded and non-configurable. No
// `editor-*` / `vscode-save-*` config key may be READ (cfgRead) anywhere in src,
// the spawn-based save-all override is gone, and the tunables are constants.
//
// Run: node Agent_Orchestrator/tests/editor-flush-hardcoded-no-config.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const FLUSH = path.join(HARNESS, 'src', 'editor-buffer-flush.js');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const flushSrc = fs.readFileSync(FLUSH, 'utf8');
const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${e && (e.message || e)}`); }
}

// Match a cfgRead for any removed editor/vscode-save key (kebab or quoted).
const REMOVED_CFGREAD = /cfgRead\([^)]*['"](?:editor-save-all-command|editor-save-all-keys|editor-window-match|editor-save-flush-ms|editor-save-flush-timeout-ms|vscode-save-all-command|vscode-save-flush-ms)['"]/;

test('editor-buffer-flush.js reads NO removed editor/vscode config key', () => {
  assert.ok(!REMOVED_CFGREAD.test(flushSrc),
    'editor-buffer-flush.js must not cfgRead any editor-*/vscode-save key');
});

test('run-agent.js reads NO removed editor/vscode config key', () => {
  assert.ok(!REMOVED_CFGREAD.test(runAgentSrc),
    'run-agent.js must not cfgRead any editor-*/vscode-save key');
});

test('editor-buffer-flush.js no longer requires configUtils for flush tuning', () => {
  // The module is fully hardcoded now; no cfgRead calls at all.
  assert.ok(!/cfgRead\(/.test(flushSrc), 'no cfgRead should remain in editor-buffer-flush.js');
});

test('hardcoded constants are present (FLUSH_MS / KEYSTROKE_TIMEOUT / WIN_MATCH / fallback chord)', () => {
  assert.ok(/const\s+FLUSH_MS\s*=\s*200/.test(flushSrc), 'FLUSH_MS=200 const expected');
  assert.ok(/const\s+KEYSTROKE_TIMEOUT\s*=\s*8000/.test(flushSrc), 'KEYSTROKE_TIMEOUT=8000 const expected');
  assert.ok(/const\s+WIN_MATCH\s*=\s*\/code\|cursor\|codium\|devenv\|sublime_text\|idea64\|rider64\//.test(flushSrc),
    'WIN_MATCH regex const expected');
  assert.ok(/SAVE_ALL_FALLBACK\s*=\s*'\^\(k\)s'/.test(flushSrc), 'fallback chord ^(k)s expected');
});

test('spawn-based save-all override path is removed (no verbatim bin/rest spawn)', () => {
  assert.ok(!/spawnSync\(bin,\s*rest/.test(flushSrc), 'spawn-command override must be gone from flush module');
  assert.ok(!/spawnSync\(bin,\s*rest/.test(runAgentSrc), 'spawn-command override must be gone from run-agent flush');
});

test('run-agent flushEditorBuffers delegates to flushViaKeystroke()', () => {
  const m = runAgentSrc.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(m, 'flushEditorBuffers must exist');
  assert.ok(/flushViaKeystroke\(\)/.test(m[0]), 'must delegate to imported flushViaKeystroke()');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
