#!/usr/bin/env node
'use strict';

// Regression tests for clarifying-question notification feature.
// Run: node Agent_Orchestrator/tests/notification-config.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const GLOBAL = path.join(HARNESS, 'global-config.json');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('global-config.json declares play-notification-sound default=true', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  assert.strictEqual(cfg['play-notification-sound'], true);
  assert.strictEqual(cfg.playNotificationSound, true);
});

test('global-config.json no longer declares reminder keys or notification-sound-file', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  assert.ok(!('play-reminder-notifications' in cfg), 'play-reminder-notifications must be removed');
  assert.ok(!('reminder-notification-freq' in cfg), 'reminder-notification-freq must be removed');
  assert.ok(!('notification-sound-file' in cfg), 'notification-sound-file must be removed');
});

test('inline // comments preserved through round-trip', () => {
  const raw = fs.readFileSync(GLOBAL, 'utf8');
  assert.ok(raw.includes('"// play-notification-sound"'));
  assert.ok(!raw.includes('"// play-reminder-notifications"'));
  assert.ok(!raw.includes('"// reminder-notification-freq"'));
});

test('cfgRead cascade: topic value overrides global', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  const topic = { 'play-notification-sound': false };
  assert.strictEqual(configUtils.cfgRead(topic, cfg, 'play-notification-sound', true), false);
  assert.strictEqual(configUtils.cfgRead(null,  cfg, 'play-notification-sound', true), true);
});

test('cfgRead fallback when key absent everywhere', () => {
  assert.strictEqual(configUtils.cfgRead({}, {}, 'play-notification-sound', true), true);
  assert.strictEqual(configUtils.cfgRead({}, {}, 'clarifying-sound-file', 'x.wav'), 'x.wav');
});

test('start-topic strips notification keys via global cascade (keys present in global-config.json)', () => {
  // start-topic.js uses stripGloballyDefinedKeys to exclude any key already in global-config.json.
  const cfg = configUtils.loadConfig(GLOBAL);
  assert.ok('play-notification-sound' in cfg, 'play-notification-sound must be in global-config.json');
  // Also verify start-topic.js uses the cascade-stripping mechanism.
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'start-topic.js'), 'utf8');
  assert.ok(src.includes('stripGloballyDefinedKeys'), 'start-topic must call stripGloballyDefinedKeys');
});

test('run-agent.js: reminder loop + playNotificationSound removed, startClarifyingQuestionWait kept', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(/function startClarifyingQuestionWait\(/.test(src));
  assert.ok(!/function playNotificationSound\(/.test(src), 'playNotificationSound must be removed');
  assert.ok(!/function stopClarifyingQuestionWait\(/.test(src), 'stopClarifyingQuestionWait must be removed');
  assert.ok(!/setInterval\(playNotificationSound/.test(src), 'reminder setInterval must be removed');
  assert.ok(!/reminder-notification-freq/.test(src), 'reminder freq config read must be removed');
});

test('startClarifyingQuestionWait wired before promptForUserReply (gates both branches)', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  const idxStart = src.indexOf('startClarifyingQuestionWait();');
  const idxPrompt = src.indexOf('await promptForUserReply(');
  assert.ok(idxStart > 0 && idxPrompt > idxStart, 'startClarifyingQuestionWait must precede promptForUserReply');
});

test('isFinal gate removed: clarifying-question handler runs for final phase too', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(!/if \(!isFinal\)\s*\{\s*const paused = await handleClarifyingQuestionsIfAny/.test(src),
    'final-phase gate still present — coding-only pipeline will skip pause');
  assert.ok(src.includes('handleClarifyingQuestionsIfAny'));
});

test('coding phase re-runs after clarifying-question reply (parity with planning)', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(/phaseName === 'planning' \|\| phaseName === 'coding'/.test(src),
    'coding rerun branch missing — assessment would see only questions');
});

test('platform branch: win32 plays .wav via Media.SoundPlayer (silent on error), else BEL', () => {
  // Per user request every per-event sound is a `.wav` file played via
  // `Media.SoundPlayer`; a missing/locked file now fails SILENTLY (synthesized
  // `[console]::beep` fallback removed).
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(/process\.platform === 'win32'/.test(src));
  assert.ok(/Media\.SoundPlayer/.test(src), 'win32 must play the resolved .wav via Media.SoundPlayer');
  assert.ok(!/\[console\]::beep/.test(src), 'win32 must NOT keep a [console]::beep fallback tone');
  assert.ok(/'\\x07'/.test(src), 'non-win32 must write BEL char');
});

// Per-event sound contract: each `*-sound-file` key is declared in
// global-config.json (so it auto-strips from topic configs), holds a `.wav` path,
// and each run-agent.js helper passes a `.wav` default (no beep fallback arg).
const SOUND_KEYS = [
  'clarifying-sound-file',
  'queue-fetch-sound-file',
  'completion-sound-file',
  'token-limit-sound-file',
  'error-sound-file',
];

test('global-config.json declares all five per-event *-sound-file keys as .wav paths', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  for (const key of SOUND_KEYS) {
    assert.ok(key in cfg, `${key} must be declared in global-config.json`);
    assert.ok(/\.wav$/i.test(String(cfg[key]).trim()), `${key} must hold a .wav path`);
  }
});

test('each *-sound-file helper passes a .wav default with no beep fallback arg', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  for (const key of SOUND_KEYS) {
    const re = new RegExp(`_playSoundFile\\(\\s*'${key}'\\s*,\\s*'[^']*\\.wav'\\s*\\)`);
    assert.ok(re.test(src), `${key} helper must call _playSoundFile('${key}', '<wav>')`);
  }
});

test('per-event *-sound-file keys carry inline // comment docs', () => {
  const raw = fs.readFileSync(GLOBAL, 'utf8');
  for (const key of SOUND_KEYS) {
    assert.ok(raw.includes(`"// ${key}"`), `${key} must have an inline // comment`);
  }
});

test('clarifying tone gated on auto-answer-clarifying-questions-and-submit', () => {
  // In-process: playClarifyingSound early-returns when the auto-submit flag is on.
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  const fnIdx = src.indexOf('function playClarifyingSound(');
  const body = src.slice(fnIdx, fnIdx + 300);
  assert.ok(/auto-answer-clarifying-questions-and-submit/.test(body),
    'playClarifyingSound must check auto-answer-clarifying-questions-and-submit');
  // Broker path: sound.js honors AMA_SUPPRESS_CLARIFYING.
  const soundSrc = fs.readFileSync(path.join(HARNESS, 'src', 'sound.js'), 'utf8');
  assert.ok(/AMA_SUPPRESS_CLARIFYING/.test(soundSrc), 'sound.js must honor AMA_SUPPRESS_CLARIFYING');
});

if (!process.exitCode) console.log('\nAll regression tests passed.');
