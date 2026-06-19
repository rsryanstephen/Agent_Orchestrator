#!/usr/bin/env node
'use strict';

// Regression tests for the editor-agnostic buffer-flush, now hardcoded /
// non-configurable:
//   - `flushEditorBuffers` (run-agent.js) delegates to the imported keystroke flush.
//   - Back-compat alias `saveAllVsCodeBuffers` -> `flushEditorBuffers` preserved.
//   - No `editor-*` / `vscode-save-*` config reads, no spawn-command override,
//     no `--reuse-window` injection.
//   - In-pipeline call sites still invoke through the alias.
//
//   node Agent_Orchestrator/tests/editor-agnostic-buffer-flush.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

function flushBody() {
  const m = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(m, 'flushEditorBuffers block found');
  return m[0];
}

// ── (1) Function + alias preserved ────────────────────────────────────────────
test('(1) source declares function flushEditorBuffers(opts)', () => {
  assert.ok(/function\s+flushEditorBuffers\s*\(\s*opts/.test(src),
    'expected `function flushEditorBuffers(opts)` in run-agent.js');
});

test('(1) back-compat alias `const saveAllVsCodeBuffers = flushEditorBuffers` present', () => {
  assert.ok(/const\s+saveAllVsCodeBuffers\s*=\s*flushEditorBuffers/.test(src),
    'alias must remain so existing call sites + tests keep working');
});

// ── (2) Hardcoded / non-configurable: no editor-* config reads ────────────────
test('(2) flushEditorBuffers reads NO editor-*/vscode-save config key', () => {
  const body = flushBody();
  assert.ok(!/editor-save-all-command|editor-save-flush-ms|vscode-save-all-command|vscode-save-flush-ms/.test(body),
    'flush must not read any editor/vscode-save config key (hardcoded contract)');
});

// ── (3) Editor-agnostic: no --reuse-window injection ──────────────────────────
test('(3) flushEditorBuffers does NOT inject --reuse-window', () => {
  assert.ok(!/--reuse-window/.test(flushBody()),
    'hard-coded --reuse-window injection breaks non-VS-Code editors');
});

// ── (4) Delegates to the keystroke flush (sole mechanism) ─────────────────────
test('(4) flushEditorBuffers delegates to flushViaKeystroke()', () => {
  assert.ok(/flushViaKeystroke\(\)/.test(flushBody()),
    'flush must delegate to the imported keystroke flush');
});

// ── (5) No direct editor-CLI spawn remains in the flush ───────────────────────
test('(5) flushEditorBuffers no longer spawns an editor CLI directly', () => {
  assert.ok(!/spawnSync\(/.test(flushBody()),
    'spawn-command override path must be gone (keystroke flush is sole mechanism)');
});

// ── (6) Throttle + force-bypass wrapper intact (no regression) ────────────────
test('(6) per-run throttle + force bypass preserved', () => {
  const body = flushBody();
  assert.ok(/if\s*\(\s*!force\s*&&\s*_editorFlushedThisRun\s*\)\s*return/.test(body),
    'non-force phase-boundary calls must still no-op after first flush');
  assert.ok(/const\s+force\s*=\s*!!\(?\s*opts/.test(body),
    'must read opts.force to bypass the throttle at interaction boundaries');
});

// ── (7) cfgRead still returns supplied fallback for absent keys (generic) ─────
test('(7) cfgRead returns supplied fallback (not undefined) for absent keys', () => {
  assert.strictEqual(configUtils.cfgRead({}, {}, 'definitely-not-a-real-key', null), null);
  assert.strictEqual(configUtils.cfgRead({}, {}, 'definitely-not-a-real-key', 'sentinel'), 'sentinel');
});

// ── (8) Projects-dir cleanup comment attributes session JSONL to Claude Code CLI ─
test('(8) cleanup comment attributes session-file writes to the Claude Code CLI', () => {
  const aboveIdx = src.indexOf('function cleanupHarnessSessionFile');
  assert.ok(aboveIdx > 0, 'cleanup function found');
  const above = src.slice(Math.max(0, aboveIdx - 800), aboveIdx);
  assert.ok(/Claude Code CLI/.test(above),
    'comment must attribute session-file writes to the Claude Code CLI (editor-agnostic)');
});

// ── (9) Call sites still invoke through the alias (no API break) ──────────────
test('(9) call sites still invoke through alias (saveAllVsCodeBuffers)', () => {
  const callCount = (src.match(/saveAllVsCodeBuffers\(\s*(?:\{[^}]*\})?\s*\)/g) || []).length;
  assert.ok(callCount >= 3,
    `expected ≥3 call sites for saveAllVsCodeBuffers alias, found ${callCount}`);
});

console.log('done');
