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
 *  (ST9) use-detached-auto-resume: false -> calls handleTokenLimitInline (inline countdown)
 *  (ST10) use-detached-auto-resume: true -> calls scheduleSharedWake (detached OS task)
 *  (ST11) SIGINT during inline wait -> installs SIGINT handler that falls back to detached
 *  (ST12) Inline countdown format: ⏳ Session resets in HH:MM:SS
 *  (ST13) Inline-failed -> falls back to detached (catch block in runPipeline)
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

// ── ClaudeHarnessAutoResume ───────────────────────────────────────────────────

// Requirement: ClaudeHarnessAutoResume task scheduled via Register-ScheduledTask with correct name
// (README line 71: "One-shot at the parsed token-limit reset time")
test('(ST1a) ClaudeHarnessAutoResume task name constant', () => {
  assert.ok(/ClaudeHarnessAutoResume/.test(runAgentSrc),
    'run-agent.js must reference ClaudeHarnessAutoResume task name');
  const taskNameLine = runAgentSrc.match(/const taskName = '(.+?)'/);
  assert.ok(taskNameLine && taskNameLine[1] === 'ClaudeHarnessAutoResume',
    'taskName must equal "ClaudeHarnessAutoResume"');
});

// Requirement: scheduleSharedWake scriptPath uses src/auto-resume.js (post-reorganisation)
// (README: "Schedules one detached one-shot OS task")
test('(ST1b) scheduleSharedWake scriptPath points to src/auto-resume.js', () => {
  assert.ok(/path\.join\(HARNESS, 'src', 'auto-resume\.js'\)/.test(runAgentSrc),
    'scheduleSharedWake scriptPath must use HARNESS/src/auto-resume.js');
});

// Requirement: WorkingDirectory passed to Register-ScheduledTask so node starts in correct dir
// (README line 480: "The fix (already applied): task action passes -WorkingDirectory <repoRoot>")
test('(ST14) ClaudeHarnessAutoResume Register-ScheduledTask includes WorkingDirectory', () => {
  // scheduleSharedWake PS command must use -WorkingDirectory
  const wakeFnMatch = runAgentSrc.match(/function scheduleSharedWake[\s\S]*?\n\}/);
  assert.ok(wakeFnMatch, 'scheduleSharedWake function must exist');
  assert.ok(/-WorkingDirectory/.test(wakeFnMatch[0]),
    'Register-ScheduledTask action must specify -WorkingDirectory');
});

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

// ── use-detached-auto-resume ──────────────────────────────────────────────────

// Requirement: use-detached-auto-resume: false -> calls handleTokenLimitInline (inline countdown)
// (README line 528-529: "terminal blocks with a live countdown")
test('(ST9) use-detached-auto-resume: false -> handleTokenLimitInline called', () => {
  assert.ok(/!useDetached/.test(runAgentSrc), '!useDetached condition must exist');
  assert.ok(/handleTokenLimitInline\(instant, pipelineName, i\)/.test(runAgentSrc),
    'inline path must call handleTokenLimitInline');
});

// Requirement: use-detached-auto-resume: true -> scheduleSharedWake called (detached OS task)
// (README: "schedules an OS task and exits immediately")
test('(ST10) use-detached-auto-resume: true -> scheduleSharedWake + exit message', () => {
  assert.ok(/scheduleSharedWake\(instant\.getTime\(\)\)/.test(runAgentSrc),
    'detached path must call scheduleSharedWake');
  assert.ok(/You may close this CLI/.test(runAgentSrc),
    'detached path must tell user they can close the CLI');
});

// Requirement: SIGINT during inline countdown -> installs SIGINT handler that falls back to detached
// (README line 470: "If the terminal is closed or Ctrl-C is pressed during the countdown,
//  the harness catches the signal, automatically falls back to the detached path")
test('(ST11) SIGINT handler installed during inline wait -> falls back to detached', () => {
  assert.ok(/process\.once\('SIGINT', sigintHandler\)/.test(runAgentSrc),
    'SIGINT handler must be installed during inline wait');
  assert.ok(/falling back to detached/.test(runAgentSrc),
    'signal handler must log fallback-to-detached message');
  assert.ok(/scheduleSharedWake\(resetMs\)/.test(runAgentSrc),
    'signal handler must call scheduleSharedWake to register OS task');
  assert.ok(/process\.exit\(0\)/.test(runAgentSrc),
    'signal handler must exit(0) after scheduling detached task');
});

// Requirement: Inline countdown displays "⏳ Session resets in HH:MM:SS"
// (README lines 455-457: live countdown format)
test('(ST12) inline countdown format: ⏳ Session resets in HH:MM:SS', () => {
  assert.ok(/⏳ Session resets in/.test(runAgentSrc),
    'countdown must display ⏳ Session resets in prefix');
  // HH:MM:SS formatting via padStart(2,'0')
  assert.ok(/padStart\(2, '0'\)/.test(runAgentSrc),
    'countdown digits must be zero-padded to 2 chars');
  assert.ok(/✅ Session reset — resuming pipeline in-process/.test(runAgentSrc),
    'countdown end must display ✅ completion message');
});

// Requirement: Inline-failed -> catches error and falls back to detached
// (README line 470: "On any failure of the inline path, the harness automatically falls back")
test('(ST13) inline resume failure falls back to detached schedule', () => {
  // catch block after handleTokenLimitInline try
  assert.ok(/catch \(inlineErr\)/.test(runAgentSrc),
    'inline resume failure must be caught');
  assert.ok(/Inline resume failed.*falling back to detached/.test(runAgentSrc),
    'catch block must log fallback message');
  // After catch, detached path (saveResumeState + enqueueWake + scheduleSharedWake) runs
  const catchIdx = runAgentSrc.indexOf('Inline resume failed');
  const afterCatch = runAgentSrc.slice(catchIdx, catchIdx + 400);
  assert.ok(/saveResumeState/.test(afterCatch) || /enqueueWake/.test(afterCatch),
    'after inline failure, detached resume state must be saved/enqueued');
});

// ── resolveUseDetachedAutoResume ──────────────────────────────────────────────

// Requirement: legacy autoResumeMode key translated to use-detached-auto-resume
// (README line 529: "Replaces the legacy autoResumeMode: 'inline'|'detached' flag")
test('(ST15) legacy autoResumeMode translated to use-detached-auto-resume', () => {
  assert.ok(/auto-resume-mode/.test(runAgentSrc),
    'legacy auto-resume-mode key must be read as fallback');
  assert.ok(/resolveUseDetachedAutoResume/.test(runAgentSrc),
    'resolveUseDetachedAutoResume helper must exist');
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

// Requirement: enqueueWake returns false when existing job is earlier — avoids duplicate schtasks
test('(ST17) enqueueWake returns becameEarliest=false when existing entry is earlier', () => {
  // Same formula: `resetInstantMs < prevEarliest` is false when new job is later
  assert.ok(/resetInstantMs < prevEarliest/.test(runAgentSrc),
    'enqueueWake must compare resetInstantMs < prevEarliest to determine priority');
  // Caller: `if (becameEarliest) scheduleSharedWake(...)` — only register when truly earliest
  assert.ok(/if \(becameEarliest\) scheduleSharedWake/.test(runAgentSrc),
    'scheduleSharedWake must only be called when becameEarliest is true');
});

// ── scheduleSharedWake non-Windows path ───────────────────────────────────────

// Requirement: non-Windows uses `at -t` Unix scheduling (README: "or 'at' on Unix")
test('(ST18) scheduleSharedWake non-Windows uses at -t command', () => {
  // Windows path uses Register-ScheduledTask; Unix path uses `at -t`
  assert.ok(/at -t/.test(runAgentSrc),
    'scheduleSharedWake must use at -t on non-Windows');
  assert.ok(/sh.*-c.*at -t/.test(runAgentSrc),
    'at -t must be invoked via sh -c');
});

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
