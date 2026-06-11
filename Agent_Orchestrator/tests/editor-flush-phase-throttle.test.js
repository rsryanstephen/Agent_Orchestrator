#!/usr/bin/env node
'use strict';

// Regression for subtask 1: VS Code icon must NOT flash in the Windows taskbar
// every time the harness starts a new phase. Root cause: `snapshotHistorySize`
// (and every phase-boundary helper that calls it) was invoking
// `saveAllVsCodeBuffers()` -> external `code --command workbench.action.files.saveAll`
// which causes VS Code's window to request user attention -> taskbar flash.
//
// Fix: per-run throttle. The FIRST call inside a harness run actually flushes
// (typically the `hrun`/`hresume` dispatch entry). Subsequent default-mode
// (non-force) calls — i.e. all the phase-boundary snapshot helpers — no-op.
// User-interaction boundaries (CLI reply finish, clarifying-questions pause,
// dispatch entry) pass `{force: true}` so they bypass the throttle and still
// capture edits the user typed during the interactive window.
//
//   node Agent_Orchestrator/tests/editor-flush-phase-throttle.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// (1) flushEditorBuffers must accept an opts arg (so callers can pass `force`).
test('flushEditorBuffers accepts opts parameter', () => {
  assert.ok(
    /function flushEditorBuffers\(\s*opts[^)]*\)/.test(src),
    'flushEditorBuffers must take an `opts` parameter to support {force: true}'
  );
});

// (2) Per-run throttle flag must exist and gate non-force calls.
test('per-run throttle flag gates non-force calls', () => {
  assert.ok(
    /let\s+_editorFlushedThisRun\s*=\s*false/.test(src),
    'expected module-level `_editorFlushedThisRun` throttle flag'
  );
  const fnMatch = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'flushEditorBuffers block found');
  const body = fnMatch[0];
  assert.ok(
    /if\s*\(\s*!force\s*&&\s*_editorFlushedThisRun\s*\)\s*return/.test(body),
    'non-force call after first flush must early-return (no taskbar flash on phase boundaries)'
  );
  assert.ok(
    /_editorFlushedThisRun\s*=\s*true/.test(body),
    'flushEditorBuffers must set the throttle flag once it has flushed'
  );
});

// (3) Force-mode bypass must read `opts.force`.
test('force option bypasses throttle', () => {
  const fnMatch = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fnMatch);
  const body = fnMatch[0];
  assert.ok(
    /const\s+force\s*=\s*!!\(?\s*opts\s*(?:&&\s*opts\.force|\?\.force|\.force)/.test(body),
    'flushEditorBuffers must read `opts.force` to allow user-interaction boundaries to bypass throttle'
  );
});

// (4) User-interaction call sites pass `{force: true}` so they always flush
// even when phase-boundary calls have already tripped the throttle.
test('dispatch entry (hrun/hresume) passes force: true', () => {
  // The dispatch IIFE invokes saveAllVsCodeBuffers BEFORE awaiting saveUserChanges.
  // That site must be force-mode -> user typed a harness command, capture buffers.
  assert.ok(
    /saveAllVsCodeBuffers\(\{\s*force:\s*true\s*\}\)\s*;\s*\n\s*await\s+saveUserChanges\(\)/.test(src),
    'dispatch entry call must pass {force: true} so hrun/hresume always flushes'
  );
});

test('clarifying-questions pause passes force: true', () => {
  // handleClarifyingQuestionsIfAny flushes before reading the reply block.
  // That site is a user-interaction boundary -> must bypass throttle.
  const handler = src.match(/async function handleClarifyingQuestionsIfAny\(\)[\s\S]*?\n\}/);
  assert.ok(handler, 'handleClarifyingQuestionsIfAny block found');
  assert.ok(
    /saveAllVsCodeBuffers\(\{\s*force:\s*true\s*\}\)/.test(handler[0]),
    'clarifying-questions pause must force-flush so it captures user edits made during the pause'
  );
});

test('post-CLI-reply finish passes force: true', () => {
  // The `finish` callback inside the promptForUserReply readline pump fires after
  // the user typed a reply at the CLI. Must force-flush before re-reading the file.
  assert.ok(
    /Force-flush[\s\S]{0,200}saveAllVsCodeBuffers\(\{\s*force:\s*true\s*\}\)/.test(src),
    'post-CLI-reply finish must pass {force: true} to force-flush before re-reading prompt file'
  );
});

// (5) Behavioural simulation of the throttle: a non-force call AFTER a force call
// (or any prior flush) must be a no-op.
test('throttle simulation: only first non-force call invokes the spawn path', () => {
  // Mirror the production logic in isolation. Models the wrapper that lives in
  // run-agent.js — anything more complete would need to load the full module.
  let _editorFlushedThisRun = false;
  let spawnCount = 0;
  function fakeFlush(opts) {
    const force = !!(opts && opts.force);
    if (!force && _editorFlushedThisRun) return;
    _editorFlushedThisRun = true;
    spawnCount++;
  }
  // Simulate a harness run: dispatch entry (force), then many phase-boundary
  // snapshotHistorySize() calls (default).
  fakeFlush({ force: true });          // spawn 1
  fakeFlush();                          // throttled
  fakeFlush();                          // throttled
  fakeFlush();                          // throttled
  fakeFlush();                          // throttled
  // Subsequent user-interaction boundary: clarifying questions (force) — must spawn.
  fakeFlush({ force: true });           // spawn 2
  // More phase-boundary noise after that — still throttled.
  fakeFlush();                          // throttled
  assert.strictEqual(spawnCount, 2,
    'expected exactly 2 spawn invocations (1 dispatch + 1 clarifying) across all simulated phase boundaries');
});

// (6) Cold-run path: a single non-force call from snapshotHistorySize is the
// ONLY call site that fires -> still flushes exactly once. This guarantees
// users who don't go through the dispatch-entry path (legacy entry points)
// don't lose all buffer flushes outright.
test('throttle simulation: first non-force call still flushes', () => {
  let _editorFlushedThisRun = false;
  let spawnCount = 0;
  function fakeFlush(opts) {
    const force = !!(opts && opts.force);
    if (!force && _editorFlushedThisRun) return;
    _editorFlushedThisRun = true;
    spawnCount++;
  }
  fakeFlush();                          // spawn 1 (cold)
  fakeFlush();                          // throttled
  fakeFlush();                          // throttled
  assert.strictEqual(spawnCount, 1,
    'first non-force call must still flush; subsequent default-mode calls must no-op');
});
