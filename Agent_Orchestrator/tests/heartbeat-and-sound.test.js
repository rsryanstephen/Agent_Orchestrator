#!/usr/bin/env node
'use strict';

// Regression tests for:
//  1. Aggregate fleet heartbeat (5s cadence, in-process counter, suppressed under reminder beep).
//  2. Pre-spawn heartbeat coverage of the `fix` (remediation) phase via `runClaude`.
//  3. Per-event `*-sound-file` keys play `.wav` files (silent on error, no beep).
// Run: node Agent_Orchestrator/tests/heartbeat-and-sound.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const GLOBAL = path.join(HARNESS, 'global-config.json');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

const src = fs.readFileSync(RUN_AGENT, 'utf8');

// `run-agent.js` ships with CRLF line endings, so a body-capture regex must
// allow an optional `\r` before the closing brace's newline. Helper centralises
// the pattern so every test matches whole-function bodies on Windows checkouts.
function fnBody(name, { trailingNewline = false } = {}) {
  const tail = trailingNewline ? '\\r?\\n\\}\\r?\\n' : '\\r?\\n\\}';
  return src.match(new RegExp(`(?:async )?function\\s+${name}\\s*\\([\\s\\S]*?${tail}`));
}

// Removed: the single `notification-sound-file` config key (and its bundled
// `assets/notification.wav` default) is dead — playback migrated to the five
// per-event synthesized `[console]::beep` helpers, none of which read that key.
// Asserting a default for an unread key only invited future confusion about
// which key drives playback.

test('playNotificationSound removed; playClarifyingSound plays a .wav', () => {
  // Synthesized beep playback removed: every event plays a `.wav` file and the
  // back-compat `playNotificationSound` alias is gone. `playClarifyingSound`
  // now passes only `(configKey, defaultWav)` — no beep-fallback arg.
  assert.ok(!fnBody('playNotificationSound'), 'playNotificationSound must be removed');
  const clar = fnBody('playClarifyingSound')[0];
  const m = clar.match(/_playSoundFile\(\s*'clarifying-sound-file'\s*,\s*'([^']*\.wav)'\s*\)/);
  assert.ok(m, 'playClarifyingSound must call _playSoundFile with a .wav default and no beep arg');
});

// Removed: bundled `.wav` opt-in no longer participates in playback (all five
// events synthesize tones via `[console]::beep`); asserting the file's presence
// implied a wav path that no longer exists.

test('runFleet emits aggregate heartbeat, not per-child still-working', () => {
  const fnMatch = fnBody('runFleet', { trailingNewline: true });
  assert.ok(fnMatch, 'runFleet not found');
  const body = fnMatch[0];
  assert.ok(/-agents\] working… topics:/.test(body),
    'aggregate heartbeat line missing from runFleet');
  assert.ok(!/\[\$\{label\}\] still working/.test(body),
    'runFleet must not emit per-child still-working lines');
});

test('runFleet heartbeat fires at 5s cadence (prespawnHeartbeatMs)', () => {
  const fnMatch = fnBody('runFleet', { trailingNewline: true });
  const body = fnMatch[0];
  assert.ok(/prespawnHeartbeatMs/.test(body),
    'runFleet should drive heartbeat from prespawnHeartbeatMs (5s), not streamingHeartbeatMs (15s)');
});

test('runFleet uses in-process counter with try/finally decrement', () => {
  const fnMatch = fnBody('runFleet', { trailingNewline: true });
  const body = fnMatch[0];
  assert.ok(/let liveCount = subtasks\.length/.test(body),
    'liveCount must initialize synchronously to subtasks.length so first 5s tick reflects true fleet size (no microtask-ordering race)');
  assert.ok(/finally\s*\{\s*liveCount--/.test(body),
    'liveCount must decrement inside try/finally so crashed children still tick down');
});

test('runFleet suppresses heartbeat when liveCount is 0', () => {
  const fnMatch = fnBody('runFleet', { trailingNewline: true });
  const body = fnMatch[0];
  assert.ok(/if \(liveCount <= 0\) return/.test(body),
    'no blank "[0 agents]" line when fleet is idle');
});

test('runClaude pre-spawn heartbeat default is 5s', () => {
  const m = src.match(/prespawnHeartbeatMs = config\.prespawnHeartbeatMs \|\| (\d+)/);
  assert.ok(m, 'prespawnHeartbeatMs default not found');
  assert.strictEqual(Number(m[1]), 5000);
});

test('runCodingAssessment (fix/remediation) routes through runClaude wrapper', () => {
  const m = fnBody('runCodingAssessment', { trailingNewline: true });
  assert.ok(m, 'runCodingAssessment not found');
  const body = m[0];
  assert.ok(/await runClaude\(payload,\s*\{[^}]*label:\s*'coding-agent'[^}]*role:\s*'coding'/.test(body),
    'fix-phase remediation must call runClaude so the 5s pre-spawn heartbeat covers it');
  assert.ok(!/silent:\s*true/.test(body),
    'serial remediation must not silence runClaude — heartbeat fires only when doStream=true');
});

test('runCodingAssessmentParallel (fix-parallel) routes through runFleet wrapper', () => {
  const m = fnBody('runCodingAssessmentParallel', { trailingNewline: true });
  assert.ok(m, 'runCodingAssessmentParallel not found');
  const body = m[0];
  assert.ok(/await runFleet\(/.test(body),
    'parallel fix must dispatch through runFleet so aggregate heartbeat covers it');
});

// Removed: inline-comment assertion for the dead `notification-sound-file` key.
// The five `*-sound-file` keys are the live playback contract (asserted below
// + in the README test); documenting an unread key was misleading.

// ── Five-chimes contract ───────────────────────────────────────────────────
// Behavioural assertions on the surface of `src/run-agent.js` (and broker)
// describing the post-refactor sound contract: ONE chime per allowed event,
// each event a DIFFERENT `.wav` file, all gated by `play-notification-sound`,
// no per-phase post-hook spam, no SIGINT chimes.

const BROKER_PATH = path.join(HARNESS, 'src', 'parallel-broker.js');
const brokerSrc = fs.readFileSync(BROKER_PATH, 'utf8');

// Five-helper contract: name -> { configKey, defaultWavRegex }
const FIVE_HELPERS = [
  { fn: 'playClarifyingSound', key: 'clarifying-sound-file' },
  { fn: 'playQueueFetchSound', key: 'queue-fetch-sound-file' },
  { fn: 'playCompletionSound', key: 'completion-sound-file' },
  { fn: 'playTokenLimitSound', key: 'token-limit-sound-file' },
  { fn: 'playErrorSound', key: 'error-sound-file' },
];

test('(a) post-hook chime removed — no `playNotificationSound`/`playChime` registered as a per-phase post hook', () => {
  // Match `registerHook('post', ...)` body and assert no chime fn appears.
  const re = /prov\.registerHook\(\s*'post'\s*,\s*\([^)]*\)\s*=>\s*\{[^}]*\}/g;
  const hooks = src.match(re) || [];
  for (const h of hooks) {
    assert.ok(!/playNotificationSound|playChime|playClarifyingSound|playCompletionSound|playTokenLimitSound|playErrorSound|playQueueFetchSound/.test(h),
      `post-hook still invokes a chime helper:\n${h}`);
  }
});

test('(b) five distinct chime helpers exist on `run-agent.js`', () => {
  for (const { fn } of FIVE_HELPERS) {
    const re = new RegExp(`function\\s+${fn}\\s*\\(`);
    assert.ok(re.test(src), `expected helper function \`${fn}\` defined in run-agent.js`);
  }
});

test('(b) each helper reads a DIFFERENT config key', () => {
  const keys = new Set();
  for (const { fn, key } of FIVE_HELPERS) {
    const bodyMatch = fnBody(fn);
    assert.ok(bodyMatch, `${fn} body not found`);
    const body = bodyMatch[0];
    assert.ok(body.includes(`'${key}'`),
      `${fn} must pass config key '${key}' to _playSoundFile`);
    assert.ok(!keys.has(key), `config key '${key}' duplicated across helpers`);
    keys.add(key);
  }
  assert.strictEqual(keys.size, 5, 'expected 5 distinct sound-file config keys');
});

test('(b) each helper resolves a DIFFERENT default `.wav` file', () => {
  // Each per-event key defaults to a named system `.wav` file; each helper passes
  // a distinct `.wav` as the 2nd (and final) arg — no beep-fallback arg remains.
  const wavs = new Set();
  for (const { fn } of FIVE_HELPERS) {
    const body = fnBody(fn)[0];
    const m = body.match(/_playSoundFile\(\s*'[^']+'\s*,\s*'([^']*\.wav)'\s*\)/);
    assert.ok(m, `${fn} must pass a default .wav file to _playSoundFile`);
    assert.ok(!wavs.has(m[1]), `.wav default '${m[1]}' duplicated across helpers`);
    wavs.add(m[1]);
  }
  assert.strictEqual(wavs.size, 5, 'expected 5 distinct default .wav files');
});

test('(b) `_playSoundFile` plays `.wav` via Media.SoundPlayer, silent on error (no beep)', () => {
  // Playback is `.wav`-file based; the shared wrapper uses `Media.SoundPlayer` and
  // keeps NO synthesized `[console]::beep` fallback (removed per user request).
  const helper = fnBody('_playSoundFile')[0];
  assert.ok(/SoundPlayer/.test(helper),
    '_playSoundFile must play the resolved .wav via Media.SoundPlayer');
  assert.ok(!/\[console\]::beep/.test(helper),
    '_playSoundFile must not synthesize a [console]::beep fallback');
  assert.ok(!/_playBeepSeq/.test(src), '_playBeepSeq must be removed entirely');
});

test('(b) broker `sound.js` mirrors run-agent.js dequeue + completion `.wav` defaults', () => {
  const soundSrc = fs.readFileSync(path.join(HARNESS, 'src', 'sound.js'), 'utf8');
  const wavOf = (body) => body.match(/'([^']*\.wav)'/)[1];
  for (const fn of ['playQueueFetchSound', 'playCompletionSound']) {
    const agentBody = src.match(new RegExp(`function\\s+${fn}\\s*\\([\\s\\S]*?\\n\\}`))[0];
    const brokerBody = soundSrc.match(new RegExp(`function\\s+${fn}\\s*\\([\\s\\S]*?\\n\\}`))[0];
    assert.strictEqual(wavOf(brokerBody), wavOf(agentBody),
      `sound.js ${fn} .wav default must match run-agent.js (got broker='${wavOf(brokerBody)}', agent='${wavOf(agentBody)}')`);
  }
});

test('(c) every helper is gated by `play-notification-sound` (via shared `_playSoundFile`)', () => {
  // The master-mute gate is consolidated in `_playSoundFile`; assert each helper
  // routes through it and that the shared wrapper enforces the gate once.
  for (const { fn } of FIVE_HELPERS) {
    const bodyMatch = fnBody(fn);
    assert.ok(bodyMatch, `${fn} body not found`);
    assert.ok(/_playSoundFile\(/.test(bodyMatch[0]),
      `${fn} must delegate to _playSoundFile so the master-mute gate applies`);
  }
  const helper = fnBody('_playSoundFile');
  assert.ok(helper, '_playSoundFile not found');
  assert.ok(/cfgRead\([^,]+,[^,]+,\s*'play-notification-sound'\s*,\s*true\s*\)/.test(helper[0]),
    '_playSoundFile must check `play-notification-sound` (master mute) before playing');
  assert.ok(/if\s*\(\s*enabled\s*===\s*false\s*\)\s*return/.test(helper[0]),
    '_playSoundFile must early-return when `play-notification-sound` is false');
});

test('(d) broker SIGINT handler fires no chime', () => {
  // Capture all SIGINT handler bodies in broker and assert none invoke a chime.
  const re = /process\.on\(\s*'SIGINT'\s*,\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*\)/g;
  const handlers = brokerSrc.match(re) || [];
  assert.ok(handlers.length > 0, 'expected at least one SIGINT handler in broker');
  for (const h of handlers) {
    assert.ok(!/playChime|playNotificationSound|playClarifyingSound|playCompletionSound|playTokenLimitSound|playErrorSound|playQueueFetchSound/.test(h),
      `broker SIGINT handler must not chime:\n${h}`);
  }
});

test('(d) `handleTokenLimitInline` SIGINT path fires no chime', () => {
  const m = fnBody('handleTokenLimitInline', { trailingNewline: true });
  assert.ok(m, 'handleTokenLimitInline not found');
  const body = m[0];
  // The signal-handler must not call any chime helper. The function MAY call
  // playTokenLimitSound at entry (the wait-begin event), but the SIGINT branch
  // (onSignal) must be chime-free.
  const sigBlock = body.match(/const\s+onSignal\s*=\s*[\s\S]*?\n\s*\}/);
  if (sigBlock) {
    assert.ok(!/playChime|playNotificationSound|playClarifyingSound|playCompletionSound|playTokenLimitSound|playErrorSound|playQueueFetchSound/.test(sigBlock[0]),
      'handleTokenLimitInline SIGINT/onSignal branch must not chime');
  }
});

test('call-site wiring: clarifying-question wait calls `playClarifyingSound` (NOT `playNotificationSound`)', () => {
  const m = src.match(/function startClarifyingQuestionWait\([\s\S]*?\n\}/);
  assert.ok(m, 'startClarifyingQuestionWait not found');
  assert.ok(/playClarifyingSound\(/.test(m[0]),
    'startClarifyingQuestionWait must call the dedicated playClarifyingSound helper');
});

test('call-site wiring: pipeline-completion path calls `playCompletionSound`', () => {
  // The completion call-site previously used `playNotificationSound`; assert
  // the dedicated helper now drives it.
  assert.ok(/playCompletionSound\(/.test(src),
    'pipeline-completion call-site must use playCompletionSound');
});

test('call-site wiring: token-limit auto-resume wait calls `playTokenLimitSound`', () => {
  assert.ok(/playTokenLimitSound\(/.test(src),
    'token-limit wait must use the dedicated playTokenLimitSound helper');
});

test('call-site wiring: error-forced session stop calls `playErrorSound`', () => {
  assert.ok(/playErrorSound\(/.test(src),
    'fatal-error exit path must use the dedicated playErrorSound helper');
});

test('README documents all five sound-file config keys', () => {
  const readme = fs.readFileSync(path.join(HARNESS, 'README.md'), 'utf8');
  for (const { key } of FIVE_HELPERS) {
    assert.ok(readme.includes(`\`${key}\``),
      `README.md missing config-key documentation for \`${key}\``);
  }
});

if (!process.exitCode) console.log('\nAll regression tests passed.');
