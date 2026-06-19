#!/usr/bin/env node
'use strict';

// Unit tests for the Save-All keybindings auto-detect / chord conversion added to
// editor-buffer-flush.js. The user's own VS Code (family) "Save All" binding must
// apply to the harness; every failure path falls back to the VS Code default
// `^(k)s`. Pure — no PowerShell spawn (resolveSaveAllChord takes injection seams).
//
// Run: node Agent_Orchestrator/tests/keybindings-chord-resolve.test.js

const path = require('path');
const assert = require('assert');

const FLUSH = path.join(__dirname, '..', 'src', 'editor-buffer-flush.js');
const { convertChordToSendKeys, parseKeybindingsForSaveAll, resolveSaveAllChord } = require(FLUSH);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${e && (e.message || e)}`); }
}

// ── chord conversion ──────────────────────────────────────────────────────────
test('ctrl+k s chord -> ^(k)s (VS Code default)', () => {
  assert.strictEqual(convertChordToSendKeys('ctrl+k s'), '^(k)s');
});

test('ctrl+shift+s -> ^+(s)', () => {
  assert.strictEqual(convertChordToSendKeys('ctrl+shift+s'), '^+(s)');
});

test('single key s -> s (no modifier)', () => {
  assert.strictEqual(convertChordToSendKeys('s'), 's');
});

test('alt key maps to % modifier', () => {
  assert.strictEqual(convertChordToSendKeys('alt+s'), '%(s)');
});

test('special key names map to SendKeys braces', () => {
  assert.strictEqual(convertChordToSendKeys('ctrl+enter'), '^({ENTER})');
});

test('cmd/meta modifier (mac) is dropped (no Windows equiv)', () => {
  assert.strictEqual(convertChordToSendKeys('cmd+s'), 's');
});

test('empty / non-string chord converts to empty string', () => {
  assert.strictEqual(convertChordToSendKeys(''), '');
  assert.strictEqual(convertChordToSendKeys(null), '');
});

// ── JSONC keybindings parse ───────────────────────────────────────────────────
test('parses saveAll binding from JSONC (comments + trailing comma)', () => {
  const jsonc = `[
    // user keybindings
    { "key": "ctrl+alt+s", "command": "workbench.action.files.saveAll" },
    { "key": "ctrl+p", "command": "workbench.action.quickOpen" }, /* trailing */
  ]`;
  assert.strictEqual(parseKeybindingsForSaveAll(jsonc), 'ctrl+alt+s');
});

test('takes the LAST positive saveAll binding (later overrides earlier)', () => {
  const jsonc = `[
    { "key": "ctrl+k s", "command": "workbench.action.files.saveAll" },
    { "key": "ctrl+alt+w", "command": "workbench.action.files.saveAll" }
  ]`;
  assert.strictEqual(parseKeybindingsForSaveAll(jsonc), 'ctrl+alt+w');
});

test('ignores negative (-command) saveAll bindings', () => {
  const jsonc = `[
    { "key": "ctrl+k s", "command": "-workbench.action.files.saveAll" }
  ]`;
  assert.strictEqual(parseKeybindingsForSaveAll(jsonc), null);
});

test('no saveAll binding -> null', () => {
  assert.strictEqual(parseKeybindingsForSaveAll('[{ "key":"ctrl+p","command":"x" }]'), null);
});

test('malformed JSON -> null (no throw)', () => {
  assert.strictEqual(parseKeybindingsForSaveAll('{ not json'), null);
});

// ── resolveSaveAllChord fallback branches (injected seams, no spawn) ───────────
test('no editor detected (procName null) -> fallback ^(k)s', () => {
  assert.strictEqual(resolveSaveAllChord({ procName: null }), '^(k)s');
});

test('non-family editor (idea64) -> JetBrains native Save-All ^(s)', () => {
  assert.strictEqual(resolveSaveAllChord({ procName: 'idea64' }), '^(s)');
});

test('Visual Studio (devenv) -> native Save-All ^+(s)', () => {
  assert.strictEqual(resolveSaveAllChord({ procName: 'devenv' }), '^+(s)');
});

test('Sublime (sublime_text) -> best-effort save ^(s)', () => {
  assert.strictEqual(resolveSaveAllChord({ procName: 'sublime_text' }), '^(s)');
});

test('missing keybindings file (readFile throws) -> fallback ^(k)s', () => {
  const chord = resolveSaveAllChord({
    keybindingsPath: 'C:/nope/keybindings.json',
    readFile: () => { throw new Error('ENOENT'); }
  });
  assert.strictEqual(chord, '^(k)s');
});

test('detected VS Code binding is converted and used', () => {
  const chord = resolveSaveAllChord({
    keybindingsPath: 'C:/fake/keybindings.json',
    readFile: () => '[{ "key": "ctrl+alt+s", "command": "workbench.action.files.saveAll" }]'
  });
  assert.strictEqual(chord, '^%(s)');
});

test('present file with no saveAll override -> fallback ^(k)s', () => {
  const chord = resolveSaveAllChord({
    keybindingsPath: 'C:/fake/keybindings.json',
    readFile: () => '[{ "key": "ctrl+p", "command": "workbench.action.quickOpen" }]'
  });
  assert.strictEqual(chord, '^(k)s');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
