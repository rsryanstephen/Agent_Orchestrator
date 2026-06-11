#!/usr/bin/env node
'use strict';

/**
 * Regression tests for auto-resume.js behaviors documented in README.md.
 * Run: node Agent_Orchestrator/tests/auto-resume.test.js
 *
 * Coverage (README "Background tasks" + "Interrupted runs" sections):
 *  (AR1) --diagnose tails last 50 lines of .state/auto-resume.log and exits
 *  (AR2) Bare `hresume` (no args) defaults filter to "all"
 *  (AR3) Filter by specific topic: matched jobs processed, unmatched jobs restored to queue
 *  (AR4) `preferred-terminal` config key read; legacy `resume-terminal` emits deprecation log
 *  (AR5) Terminal binary not found -> headless fallback log message emitted
 *  (AR6) runAgentPath points to src/run-agent.js (post-src-reorganisation fix)
 *  (AR7) Editor buffer flush called before queue read (HARNESS_EDITOR_FLUSHED env check)
 *  (AR8) Missing wake-queue exits cleanly (no crash)
 *  (AR9) Empty jobs array exits cleanly
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const autoResumeSrc = fs.readFileSync(path.join(HARNESS, 'src', 'auto-resume.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Requirement: --diagnose tails last 50 lines of auto-resume.log and exits (README line 485-488)
test('(AR1) --diagnose branch: tails 50 lines and exits', () => {
  // Source-level: diagnose path reads LOG_PATH and slices -51 lines
  assert.ok(autoResumeSrc.includes('--diagnose'), '--diagnose argv check must exist');
  assert.ok(/slice\(-51\)/.test(autoResumeSrc), 'log tail must slice last 51 lines (50 visible)');
  assert.ok(/process\.exit\(0\)/.test(autoResumeSrc), '--diagnose must exit(0)');
  // Verify LOG_PATH is the auto-resume.log
  assert.ok(/auto-resume\.log/.test(autoResumeSrc), 'LOG_PATH must reference auto-resume.log');
});

// Requirement: Bare hresume defaults filter to "all" (README line 388 + network-resume d)
test('(AR2) bare argv defaults filter to "all"', () => {
  assert.ok(/argv\.length === 0\) argv = \['all'\]/.test(autoResumeSrc),
    'bare hresume must default filter to "all"');
  // Ensure --diagnose is excluded from the filter arg check
  assert.ok(/filter\(a => a !== '--diagnose'\)/.test(autoResumeSrc),
    '--diagnose must be filtered out before argv.length check');
});

// Requirement: Filter by specific topic restores unmatched jobs to queue file (README detached mode section)
test('(AR3) topic filter: matched jobs processed, unmatched jobs restored', () => {
  // Source must restore skipped jobs back to queue when a specific topic is requested
  assert.ok(/skipped\.length > 0/.test(autoResumeSrc), 'skipped-jobs check must exist');
  assert.ok(/writeFileSync\(QUEUE, JSON\.stringify\(\{ jobs: skipped \}/.test(autoResumeSrc),
    'unmatched jobs must be written back to queue');
  // No matched -> restore ALL jobs and exit
  assert.ok(/writeFileSync\(QUEUE, JSON\.stringify\(\{ jobs \}/.test(autoResumeSrc),
    'no-match path must restore full jobs array');
});

// Requirement: preferred-terminal config key read; legacy resume-terminal emits deprecation
// (README "Configuring the spawned terminal" section lines 152-164)
test('(AR4a) preferred-terminal config key is read', () => {
  assert.ok(/cfg\['preferred-terminal'\]/.test(autoResumeSrc),
    'preferred-terminal must be read from config');
});

test('(AR4b) legacy resume-terminal emits deprecation log', () => {
  assert.ok(/resume-terminal/.test(autoResumeSrc), 'legacy resume-terminal key must be referenced');
  assert.ok(/DEPRECATION/.test(autoResumeSrc), 'deprecation log must be emitted for legacy key');
  assert.ok(/preferred-terminal/.test(autoResumeSrc), 'deprecation message must mention preferred-terminal');
});

// Requirement: Terminal binary not found -> headless fallback with log message
// (README: "If the chosen terminal binary is not found, the harness logs a warning and falls back to headless spawn")
test('(AR5) terminal not found -> headless fallback log', () => {
  assert.ok(/not found.*falling back to headless spawn/.test(autoResumeSrc) ||
            /Terminal.*not found.*falling back to headless/.test(autoResumeSrc),
    'must log terminal-not-found + fallback message');
  // headless spawn uses detached + piped stdio
  assert.ok(/detached: true/.test(autoResumeSrc), 'headless spawn must be detached');
  assert.ok(/stdio: \['ignore', out, out\]/.test(autoResumeSrc),
    'headless spawn must redirect stdio to log file');
});

// Requirement: runAgentPath must point to src/run-agent.js after the src/ reorganisation
// (Bug fix: prior value was HARNESS/run-agent.js which no longer exists)
test('(AR6) runAgentPath points to src/run-agent.js', () => {
  // The fixed path must include 'src'
  assert.ok(/path\.resolve\(HARNESS, 'src', 'run-agent\.js'\)/.test(autoResumeSrc),
    'runAgentPath must use HARNESS/src/run-agent.js');
  // Ensure the old (wrong) path is absent
  assert.ok(!/path\.resolve\(HARNESS, 'run-agent\.js'\)/.test(autoResumeSrc),
    'stale HARNESS/run-agent.js path must not be present');
});

// Requirement: editor buffer flush called before queue read (README entry-point flush, prior implementation)
test('(AR7) editor buffer flush invoked before queue read', () => {
  // The flush require must precede queue QUEUE check
  const flushIdx = autoResumeSrc.indexOf("require('./editor-buffer-flush').flushEditorBuffers()");
  const queueIdx = autoResumeSrc.indexOf('fs.existsSync(QUEUE)');
  assert.ok(flushIdx >= 0, 'editor-buffer-flush must be required');
  assert.ok(queueIdx >= 0, 'QUEUE existence check must exist');
  assert.ok(flushIdx < queueIdx, 'editor flush must precede queue read');
});

// Requirement: missing wake-queue exits cleanly (no crash, logs message)
test('(AR8) missing wake-queue file exits cleanly', () => {
  assert.ok(/No wake queue found — nothing to resume/.test(autoResumeSrc),
    'must log "No wake queue found" message');
  assert.ok(/process\.exit\(0\)/.test(autoResumeSrc), 'must exit(0) when queue absent');
});

// Requirement: empty jobs array exits cleanly (README: wake queue empty case)
test('(AR9) empty jobs array exits cleanly', () => {
  assert.ok(/Wake queue empty/.test(autoResumeSrc), 'must log "Wake queue empty"');
  // jobs.length === 0 -> exit
  assert.ok(/jobs\.length === 0/.test(autoResumeSrc), 'must guard on empty jobs array');
});

// Requirement: all terminal modes (git-bash, cmd, powershell, wt) handled
// (README "Configuring the spawned terminal" table)
test('(AR10) all preferred-terminal modes present', () => {
  for (const mode of ['git-bash', 'cmd', 'powershell', 'wt']) {
    assert.ok(autoResumeSrc.includes(mode), `terminal mode "${mode}" must be handled`);
  }
  // none -> headless spawn (no window branch)
  assert.ok(/resumeTerminal !== 'none'/.test(autoResumeSrc), '"none" mode must skip terminal spawn');
});

// Requirement: file-lock uses .lock suffix (acquireFileLock pattern prevents double-spawn)
// (README: "race-safe wake queue — locking prevents double-resume")
test('(AR11) acquireFileLock appends .lock suffix to target path', () => {
  assert.ok(/targetPath \+ '\.lock'/.test(autoResumeSrc),
    'acquireFileLock must append ".lock" to targetPath');
  assert.ok(/acquireFileLock\(QUEUE\)/.test(autoResumeSrc),
    'queue read must be wrapped in acquireFileLock');
  assert.ok(/releaseFileLock/.test(autoResumeSrc),
    'releaseFileLock must be called after queue ops');
});

// Requirement: per-job resume log named resume-<topic>.log
// (README: "each resumed topic writes to its own log")
test('(AR12) per-job resume log file uses resume-<topic>.log pattern', () => {
  assert.ok(/`resume-\$\{job\.topic\}\.log`/.test(autoResumeSrc),
    'resume log filename must be "resume-${job.topic}.log"');
  assert.ok(/STATE_DIR.*resume-.*log/.test(autoResumeSrc) ||
            /path\.resolve\(STATE_DIR, `resume-/.test(autoResumeSrc),
    'resume log must be placed in STATE_DIR');
});

// Requirement: spawned terminal processes use ROOT as working directory
// (README line 480: "task action passes -WorkingDirectory <repoRoot>")
test('(AR13) all terminal spawn commands set cwd to ROOT', () => {
  // Every child = spawn(...) or spawnSync in the terminal-spawn loop must use cwd: ROOT
  assert.ok(/cwd: ROOT/.test(autoResumeSrc),
    'terminal spawn must use cwd: ROOT');
  // headless spawn also uses cwd: ROOT
  const headlessBlock = autoResumeSrc.match(/const out = fs\.openSync[\s\S]*?child\.unref\(\)/);
  assert.ok(headlessBlock, 'headless spawn block must exist');
  assert.ok(/cwd: ROOT/.test(headlessBlock[0]),
    'headless spawn must also set cwd: ROOT');
});

if (_failed === 0) console.log('\nAll auto-resume regression tests passed.');
else { console.error(`\n${_failed} test(s) failed.`); process.exitCode = 1; }
