#!/usr/bin/env node
'use strict';

// Regression tests for the requirement:
//   "If a repository is open in a text editor or IDE that contains the harness
//    at its root, the harness should save all unsaved changes in the IDE /
//    Text Editor as the user types any harness command such as hrun or hresume."
//
// The flush logic already exists inside run-agent.js (`flushEditorBuffers`)
// but only fires DURING the pipeline (Enter-twice pauses, history snapshot).
// That is too late for IDE edits made between the last paused phase and the
// next `hrun` / `hresume` command — those edits sit in the editor buffer and
// can be clobbered by the harness writing to the same files. The fix wires a
// shared `editor-buffer-flush.js` module and calls it at the TOP of the
// entry-point scripts so the flush happens the moment the user types the
// command (before argv parsing branches into spawn/dispatch).
//
//   node Agent_Orchestrator/tests/entry-point-buffer-flush.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const MODULE = path.join(HARNESS, 'src', 'editor-buffer-flush.js');
const RUN_PARALLEL = path.join(HARNESS, 'src', 'run-parallel.js');
const AUTO_RESUME = path.join(HARNESS, 'src', 'auto-resume.js');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── (1) Shared module exists and exports flushEditorBuffers ───────────────────
test('shared module editor-buffer-flush.js exists and exports flushEditorBuffers', () => {
  assert.ok(fs.existsSync(MODULE), 'editor-buffer-flush.js must exist at harness root');
  const mod = require(MODULE);
  assert.strictEqual(typeof mod.flushEditorBuffers, 'function',
    'module must export flushEditorBuffers fn');
  assert.strictEqual(typeof mod.saveAllVsCodeBuffers, 'function',
    'module must also export back-compat alias saveAllVsCodeBuffers');
});

// ── (2) Module is invokable standalone (no topicConfig / config required) ─────
test('module flushEditorBuffers() runs without args (lazy-loads global config)', () => {
  // Simulates an entry-point script call. Must not throw -> entry points can
  // require + call before any topic context is loaded.
  const { flushEditorBuffers } = require(MODULE);
  // Disable spawn side effects by setting the env var indirectly via topicConfig.
  let threw = null;
  try { flushEditorBuffers({ 'editor-save-all-command': '' }); }
  catch (e) { threw = e; }
  assert.strictEqual(threw, null, 'flushEditorBuffers must not throw on entry-point call');
});

// ── (3) run-parallel.js (hrun) requires + calls the flush at top of file ──────
test('run-parallel.js requires editor-buffer-flush module', () => {
  const src = fs.readFileSync(RUN_PARALLEL, 'utf8');
  assert.ok(/require\(['"]\.\/editor-buffer-flush['"]\)/.test(src),
    'run-parallel.js must require ./editor-buffer-flush');
});

test('run-parallel.js calls flushEditorBuffers() BEFORE dispatching tokens', () => {
  const src = fs.readFileSync(RUN_PARALLEL, 'utf8');
  const flushIdx = src.search(/require\(['"]\.\/editor-buffer-flush['"]\)\.flushEditorBuffers\(\)/);
  // The flush must precede argv tokenization so it captures buffers ASAP.
  const tokensIdx = src.indexOf('process.argv.slice(2)');
  const spawnIdx = src.indexOf('spawn(process.execPath');
  assert.ok(flushIdx > 0, 'flushEditorBuffers() call missing in run-parallel.js');
  assert.ok(flushIdx < tokensIdx, 'flush must run before argv parsing');
  assert.ok(flushIdx < spawnIdx, 'flush must run before any child spawn');
});

// ── (4) auto-resume.js (hresume) requires + calls the flush ───────────────────
test('auto-resume.js requires editor-buffer-flush module', () => {
  const src = fs.readFileSync(AUTO_RESUME, 'utf8');
  assert.ok(/require\(['"]\.\/editor-buffer-flush['"]\)/.test(src),
    'auto-resume.js must require ./editor-buffer-flush');
});

test('auto-resume.js calls flushEditorBuffers() before reading wake queue', () => {
  const src = fs.readFileSync(AUTO_RESUME, 'utf8');
  const flushIdx = src.search(/require\(['"]\.\/editor-buffer-flush['"]\)\.flushEditorBuffers\(\)/);
  const queueReadIdx = src.indexOf("fs.existsSync(QUEUE)");
  assert.ok(flushIdx > 0, 'flushEditorBuffers() call missing in auto-resume.js');
  assert.ok(flushIdx < queueReadIdx,
    'flush must precede wake-queue read so unsaved edits to topic files reach disk first');
});

test('auto-resume.js flush is gated AFTER the --diagnose early-exit', () => {
  // --diagnose is a pure read-only tail of the log; calling the flush there
  // would spawn an editor for no reason. The flush must live below the
  // diagnose handler's process.exit(0).
  const src = fs.readFileSync(AUTO_RESUME, 'utf8');
  const diagnoseIdx = src.indexOf("--diagnose");
  const diagnoseExitIdx = src.indexOf("process.exit(0)", diagnoseIdx);
  const flushIdx = src.search(/require\(['"]\.\/editor-buffer-flush['"]\)\.flushEditorBuffers\(\)/);
  assert.ok(diagnoseExitIdx > 0, 'diagnose handler exits cleanly');
  assert.ok(flushIdx > diagnoseExitIdx,
    '--diagnose path must short-circuit before the flush spawn');
});

// ── (5) Flush is best-effort (try/catch) so a misconfigured editor never blocks the user ─
test('entry-point flush calls are wrapped in try/catch (best-effort, never blocks dispatch)', () => {
  for (const f of [RUN_PARALLEL, AUTO_RESUME]) {
    const src = fs.readFileSync(f, 'utf8');
    // The single-line `try { require(...).flushEditorBuffers(); } catch {}` pattern.
    assert.ok(
      /try\s*\{\s*require\(['"]\.\/editor-buffer-flush['"]\)\.flushEditorBuffers\(\)\s*;?\s*\}\s*catch/.test(src),
      `${path.basename(f)} must wrap flush in try/catch so a broken editor CLI never aborts the command`
    );
  }
});

// ── (6) Existing in-pipeline flush in run-agent.js remains intact (no regression) ─
test('run-agent.js still declares flushEditorBuffers() + saveAllVsCodeBuffers alias', () => {
  const src = fs.readFileSync(RUN_AGENT, 'utf8');
  assert.ok(/function\s+flushEditorBuffers\s*\(/.test(src),
    'run-agent.js must still declare flushEditorBuffers (in-pipeline call sites depend on it)');
  assert.ok(/const\s+saveAllVsCodeBuffers\s*=\s*flushEditorBuffers/.test(src),
    'back-compat alias must remain so existing call sites + tests keep working');
});

// ── (6b) HARNESS_EDITOR_FLUSHED=1 short-circuits redundant flushes in children ─
test('HARNESS_EDITOR_FLUSHED=1 skips spawn (prevents entry-point + child double-flush)', () => {
  // Reload the module fresh so internal state (if any) is clean.
  delete require.cache[require.resolve(MODULE)];
  const { flushEditorBuffers } = require(MODULE);
  const cp = require('child_process');
  const orig = cp.spawnSync;
  let spawned = false;
  cp.spawnSync = function () { spawned = true; return { status: 0 }; };
  const prevEnv = process.env.HARNESS_EDITOR_FLUSHED;
  process.env.HARNESS_EDITOR_FLUSHED = '1';
  try {
    flushEditorBuffers({}, {});
  } finally {
    cp.spawnSync = orig;
    if (prevEnv === undefined) delete process.env.HARNESS_EDITOR_FLUSHED;
    else process.env.HARNESS_EDITOR_FLUSHED = prevEnv;
  }
  assert.strictEqual(spawned, false,
    'env flag set by ancestor flush must short-circuit child spawn -> no double taskbar flash');
});

test('successful flush sets HARNESS_EDITOR_FLUSHED=1 so spawned children inherit it', () => {
  delete require.cache[require.resolve(MODULE)];
  const { flushEditorBuffers } = require(MODULE);
  const cp = require('child_process');
  const orig = cp.spawnSync;
  cp.spawnSync = function () { return { status: 0 }; };
  const prevEnv = process.env.HARNESS_EDITOR_FLUSHED;
  delete process.env.HARNESS_EDITOR_FLUSHED;
  try {
    flushEditorBuffers({ 'editor-save-all-command': 'echo', 'editor-save-flush-ms': 0 }, {});
    assert.strictEqual(process.env.HARNESS_EDITOR_FLUSHED, '1',
      'env flag must be set after successful flush so child processes skip duplicate spawn');
  } finally {
    cp.spawnSync = orig;
    if (prevEnv === undefined) delete process.env.HARNESS_EDITOR_FLUSHED;
    else process.env.HARNESS_EDITOR_FLUSHED = prevEnv;
  }
});

// ── (7) Flush is hardcoded — config no longer gates it; only the inherited
// HARNESS_EDITOR_FLUSHED guard skips the spawn (covered by 6b above). The former
// explicit-"" opt-out was removed when the flush became non-configurable.
