#!/usr/bin/env node
'use strict';

/**
 * Regression tests for scheduled-task behaviors documented in README.md.
 * Run: node Agent_Orchestrator/tests/scheduled-tasks.test.js
 *
 * Coverage (README "Background tasks" section + "Interrupted runs" section):
 *  (ST1) ClaudeHarnessAutoResume: scheduleSharedWake uses correct task name + src/auto-resume.js path
 *  (ST2) ClaudeHarnessModelsRefresh: TASK_NAME constant + weekly Sunday trigger in PS command
 *  (ST3) ClaudeHarnessModelsRefresh: SCRIPT_PATH points to src/update-models-reference.js
 *  (ST4) ClaudeHarnessModelsRefresh: non-Windows returns {ok:false, reason:'non-windows'}
 *  (ST5) ClaudeHarnessModelsRefresh: marker-based idempotence (skips PS when marker present)
 *  (ST6) ClaudeHarnessModelsRefresh: --force skips marker check
 *  (ST7) ensureModelsRefreshScheduled called lazily on hrun startup in run-agent.js
 *  (ST8) auto-resume-on-token-limit: false disables entire auto-resume block
 *  (ST9) token-limit path calls handleTokenLimitInline unconditionally
 *  (ST10) use-detached-auto-resume flag + resolver fully removed
 *  (ST11) SIGINT during inline wait exits cleanly (no detached fallback)
 *  (ST12) Inline countdown format: ⏳ Session resets in HH:MM:SS
 *  (ST13) Inline-failed -> surfaces manual hresume guidance
 *  (ST15) legacy auto-resume-mode fallback removed
 *  (ST14) WorkingDirectory passed to ClaudeHarnessAutoResume Register-ScheduledTask action
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
const scheduleRefreshSrc = fs.readFileSync(path.join(HARNESS, 'src', 'schedule-models-refresh.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── ClaudeHarnessAutoResume (removed — inline-only auto-resume) ──────────────

// Requirement: scheduleSharedWake + ClaudeHarnessAutoResume task plumbing fully
// deleted alongside the `use-detached-auto-resume` flag. No OS-level wake task
// is registered for token-limit interruptions any more.
test('(ST1a) ClaudeHarnessAutoResume task plumbing fully removed', () => {
  assert.ok(!/ClaudeHarnessAutoResume/.test(runAgentSrc),
    'ClaudeHarnessAutoResume task name must not appear in run-agent.js');
  assert.ok(!/function scheduleSharedWake/.test(runAgentSrc),
    'scheduleSharedWake function must be deleted');
  assert.ok(!/Register-ScheduledTask/.test(runAgentSrc),
    'Register-ScheduledTask plumbing must be gone from run-agent.js');
});

// (ST14 removed — WorkingDirectory check is moot now that scheduleSharedWake is gone.)

// ── ClaudeHarnessModelsRefresh ────────────────────────────────────────────────

// Requirement: TASK_NAME is ClaudeHarnessModelsRefresh (README line 72)
test('(ST2a) ClaudeHarnessModelsRefresh TASK_NAME constant', () => {
  assert.ok(/ClaudeHarnessModelsRefresh/.test(scheduleRefreshSrc),
    'schedule-models-refresh.js must reference ClaudeHarnessModelsRefresh');
  const tn = scheduleRefreshSrc.match(/const TASK_NAME = '(.+?)'/);
  assert.ok(tn && tn[1] === 'ClaudeHarnessModelsRefresh',
    'TASK_NAME must equal "ClaudeHarnessModelsRefresh"');
});

// Requirement: Weekly Sunday 03:00 trigger (README line 72: "Weekly (Sunday 03:00 local)")
test('(ST2b) weekly Sunday 03:00 trigger in PS command', () => {
  assert.ok(/-Weekly/.test(scheduleRefreshSrc), 'PS trigger must be Weekly');
  assert.ok(/-DaysOfWeek Sunday/.test(scheduleRefreshSrc), 'trigger must fire on Sunday');
  // 03:00 local: setHours(3,0,0,0) in the scheduling logic
  assert.ok(/setHours\(3, 0, 0, 0\)/.test(scheduleRefreshSrc), 'schedule must set time to 03:00');
});

// Requirement: SCRIPT_PATH points to src/update-models-reference.js (post-reorganisation)
// (README: "Runs update-models-reference.js so models-reference.md stays current")
test('(ST3) SCRIPT_PATH points to src/update-models-reference.js', () => {
  assert.ok(/path\.join\(HARNESS, 'src', 'update-models-reference\.js'\)/.test(scheduleRefreshSrc),
    'SCRIPT_PATH must use HARNESS/src/update-models-reference.js');
});

// Requirement: non-Windows platform returns {ok:false, reason:'non-windows'} without spawning PS
// (README: "Windows only")
test('(ST4) non-Windows returns {ok:false, reason:"non-windows"} without PS call', () => {
  // Platform guard at top of ensureModelsRefreshScheduled
  assert.ok(/process\.platform !== 'win32'/.test(scheduleRefreshSrc),
    'platform check must exist');
  assert.ok(/reason: 'non-windows'/.test(scheduleRefreshSrc),
    'must return reason:"non-windows" on non-Windows');
  // Unix notice logged once via marker file
  assert.ok(/models-refresh-unix-notice/.test(scheduleRefreshSrc),
    'unix notice marker must exist to suppress repeated logs');
});

// Requirement: marker-based idempotence — skips PS call when marker file present
// (README line 72: "Registered idempotently — re-runs of hrun skip if already present")
test('(ST5) marker-present path skips PS and returns {ok:true, reason:"marker-present"}', () => {
  assert.ok(/reason: 'marker-present'/.test(scheduleRefreshSrc),
    'must return reason:"marker-present" when marker file exists');
  // Logic: !force && fs.existsSync(MARKER) -> return early
  assert.ok(/!force && fs\.existsSync\(MARKER\)/.test(scheduleRefreshSrc),
    'marker check must be guarded by !force');
});

// Requirement: --force flag re-registers (skips both marker and task check)
// (README: "Force-refresh with node schedule-models-refresh.js --force")
test('(ST6) --force skips marker check and re-registers', () => {
  // force arg passed through to ensureModelsRefreshScheduled
  assert.ok(/process\.argv\.includes\('--force'\)/.test(scheduleRefreshSrc),
    '--force must be read from argv');
  assert.ok(/force = false/.test(scheduleRefreshSrc) || /\{ force = false/.test(scheduleRefreshSrc),
    'force defaults to false');
  // When force=true the marker check (!force && ...) is bypassed -> proceeds to PS registration
  assert.ok(/if \(!force && fs\.existsSync\(MARKER\)\)/.test(scheduleRefreshSrc),
    'marker guard must use !force so --force skips it');
});

// ── run-agent.js startup / lazy registration ──────────────────────────────────

// Requirement: ensureModelsRefreshScheduled called lazily on hrun startup
// (README line 67: "registers OS-level scheduled tasks lazily on hrun startup")
test('(ST7) run-agent.js lazily calls ensureModelsRefreshScheduled at dispatch startup', () => {
  assert.ok(/require\('\.\/schedule-models-refresh\.js'\)/.test(runAgentSrc),
    'run-agent.js must require schedule-models-refresh.js');
  assert.ok(/ensureModelsRefreshScheduled\(\)/.test(runAgentSrc),
    'ensureModelsRefreshScheduled must be called at startup');
  // Wrapped in try/catch so failure is non-fatal
  const requireIdx = runAgentSrc.indexOf("require('./schedule-models-refresh.js')");
  const nearbyTryCatch = runAgentSrc.slice(Math.max(0, requireIdx - 200), requireIdx + 200);
  assert.ok(/try \{/.test(nearbyTryCatch) && /\} catch/.test(nearbyTryCatch),
    'ensureModelsRefreshScheduled call must be wrapped in try/catch');
});

// ── auto-resume-on-token-limit config flag ────────────────────────────────────

// Requirement: auto-resume-on-token-limit: false disables all auto-resume behavior
// (README line 528: "Set to false to require manual hrun <id>-cont")
test('(ST8) auto-resume-on-token-limit: false disables auto-resume block', () => {
  assert.ok(/cfgRead\(topicConfig, config, 'auto-resume-on-token-limit', true\)/.test(runAgentSrc),
    'auto-resume-on-token-limit must be read from config with default true');
  assert.ok(/autoResume.*!== false/.test(runAgentSrc),
    'auto-resume must be gated on the config flag');
  // When flag is false, neither inline nor detached path should be entered
  // (the tokenReset && autoResume && instant branch handles it)
  assert.ok(/err\.tokenReset && autoResume/.test(runAgentSrc),
    'token-reset path must check autoResume flag');
});

// ── inline-only auto-resume (use-detached-auto-resume flag removed) ──────────

// Requirement: token-limit auto-resume path always calls handleTokenLimitInline
// (the live countdown), with no detached-vs-inline branch and no detached fallback.
test('(ST9) token-limit path calls handleTokenLimitInline unconditionally', () => {
  assert.ok(/handleTokenLimitInline\(instant, pipelineName, i\)/.test(runAgentSrc),
    'inline path must call handleTokenLimitInline with the pipeline+phase index');
});

// Requirement: the use-detached-auto-resume flag and its resolver are gone.
test('(ST10) use-detached-auto-resume flag fully removed', () => {
  assert.ok(!/use-detached-auto-resume/.test(runAgentSrc),
    '"use-detached-auto-resume" must not appear in run-agent.js');
  assert.ok(!/resolveUseDetachedAutoResume/.test(runAgentSrc),
    'resolveUseDetachedAutoResume helper must be deleted');
  assert.ok(!/You may close this CLI/.test(runAgentSrc),
    'detached "You may close this CLI" message must be removed');
});

// Requirement: SIGINT during inline countdown -> exits cleanly (no detached fallback)
test('(ST11) SIGINT during inline wait exits cleanly without scheduling detached task', () => {
  assert.ok(/process\.once\('SIGINT', sigintHandler\)/.test(runAgentSrc),
    'SIGINT handler must be installed during inline wait');
  assert.ok(!/falling back to detached/.test(runAgentSrc),
    'no "falling back to detached" log lines should remain');
  assert.ok(/process\.exit\(0\)/.test(runAgentSrc),
    'signal handler must still exit(0)');
  // Lock the inline-only contract: signal path must NOT call scheduleSharedWake
  // (helper is removed) nor enqueueWake — otherwise the "no detached fallback"
  // promise quietly regresses.
  assert.ok(!/scheduleSharedWake\(/.test(runAgentSrc),
    'no scheduleSharedWake call sites should remain anywhere in run-agent.js');
  const onSignalBody = runAgentSrc.match(/const onSignal = \(sig\) => \{[\s\S]*?\n  \};/);
  assert.ok(onSignalBody, 'onSignal handler must exist');
  assert.ok(!/enqueueWake\(/.test(onSignalBody[0]),
    'signal handler must not enqueue a wake-queue entry');
});

// Requirement: Inline countdown displays "⏳ Session resets in HH:MM:SS"
test('(ST12) inline countdown format: ⏳ Session resets in HH:MM:SS', () => {
  assert.ok(/⏳ Session resets in/.test(runAgentSrc),
    'countdown must display ⏳ Session resets in prefix');
  assert.ok(/padStart\(2, '0'\)/.test(runAgentSrc),
    'countdown digits must be zero-padded to 2 chars');
  assert.ok(/✅ Session reset — resuming pipeline in-process/.test(runAgentSrc),
    'countdown end must display ✅ completion message');
});

// Requirement: Inline-failure path no longer schedules a detached task — it
// surfaces a manual-resume message pointing at `hrun <topic>-cont` (which
// reads `.state/<topic>.json` saved by saveResumeState). `hresume` would not
// work here because the token-limit branch does not enqueue a wake-queue job.
test('(ST13) inline resume failure surfaces manual hrun -cont guidance', () => {
  assert.ok(/catch \(inlineErr\)/.test(runAgentSrc),
    'inline resume failure must be caught');
  assert.ok(/resume manually with \\`hrun \$\{topic\}-cont\\`/.test(runAgentSrc),
    'catch block must point user at `hrun <topic>-cont`');
});

// Requirement: legacy "auto-resume-mode" translation removed alongside the flag.
test('(ST15) legacy auto-resume-mode key no longer read', () => {
  assert.ok(!/auto-resume-mode/.test(runAgentSrc),
    'legacy auto-resume-mode fallback must be removed');
});

// ── enqueueWake becameEarliest logic ─────────────────────────────────────────

// Requirement: enqueueWake returns true when queue is empty (first entry is always earliest)
test('(ST16) enqueueWake returns becameEarliest=true when queue starts empty', () => {
  // Source: `const becameEarliest = (prevEarliest == null) || (resetInstantMs < prevEarliest)`
  assert.ok(/prevEarliest == null/.test(runAgentSrc),
    'enqueueWake must return true when prevEarliest is null');
  assert.ok(/becameEarliest = \(prevEarliest == null\) \|\| \(resetInstantMs < prevEarliest\)/.test(runAgentSrc),
    'becameEarliest formula must cover both null and earlier-time cases');
});

// Requirement: enqueueWake returns false when existing job is earlier — used
// by the network-error branch to keep the wake-queue file deduplicated. The
// scheduleSharedWake helper is intentionally GONE; do not re-introduce it.
test('(ST17) enqueueWake becameEarliest=false formula intact; scheduleSharedWake stays removed', () => {
  assert.ok(/resetInstantMs < prevEarliest/.test(runAgentSrc),
    'enqueueWake must compare resetInstantMs < prevEarliest to determine priority');
  assert.ok(!/function scheduleSharedWake/.test(runAgentSrc),
    'scheduleSharedWake must remain deleted — inline-only auto-resume is the contract');
});

// (ST18 removed — scheduleSharedWake Unix `at -t` path no longer exists.)

// ── waitUntilWithCountdown terminal prompt ────────────────────────────────────

// Requirement: countdown prompt tells user to keep terminal open
// (README line 456: "keep this terminal open")
test('(ST19) waitUntilWithCountdown prompts user to keep terminal open', () => {
  assert.ok(/please keep this terminal open/.test(runAgentSrc),
    'countdown must tell user to keep terminal open');
});

// ── SIGHUP handler Windows gate ───────────────────────────────────────────────

// Requirement: SIGHUP handler only installed on non-Windows (SIGHUP not supported on Windows)
test('(ST20) SIGHUP handler in handleTokenLimitInline is gated on non-Windows', () => {
  // process.once('SIGHUP', ...) must only appear inside a platform !== 'win32' guard
  assert.ok(/process\.platform !== 'win32'\) process\.once\('SIGHUP'/.test(runAgentSrc),
    'SIGHUP handler must be gated on process.platform !== "win32"');
  assert.ok(/process\.platform !== 'win32'\) process\.off\('SIGHUP'/.test(runAgentSrc),
    'SIGHUP removal must also be gated on non-Windows');
});

// ── schedule-models-refresh.js already-registered path ───────────────────────

// Requirement: task already in PS but marker missing -> marker restored + reason 'already-registered'
// (Idempotence: avoids double-registration on first hrun after marker deletion)
test('(ST21) taskAlreadyRegistered path restores marker and returns reason:"already-registered"', () => {
  assert.ok(/reason: 'already-registered'/.test(scheduleRefreshSrc),
    'must return reason:"already-registered" when PS task exists but marker was missing');
  assert.ok(/rediscoveredAt/.test(scheduleRefreshSrc),
    'restored marker must include rediscoveredAt timestamp');
  assert.ok(/taskAlreadyRegistered\(\)/.test(scheduleRefreshSrc),
    'taskAlreadyRegistered helper must be called when marker is absent');
});

if (_failed === 0) console.log('\nAll scheduled-tasks regression tests passed.');
else { console.error(`\n${_failed} test(s) failed.`); process.exitCode = 1; }
