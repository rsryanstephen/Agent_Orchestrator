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

test('global-config.json declares play-reminder-notifications default=false', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  assert.strictEqual(cfg['play-reminder-notifications'], false);
});

test('global-config.json declares reminder-notification-freq default=300', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  assert.strictEqual(cfg['reminder-notification-freq'], 300);
});

test('inline // comments preserved through round-trip', () => {
  const raw = fs.readFileSync(GLOBAL, 'utf8');
  assert.ok(raw.includes('"// play-notification-sound"'));
  assert.ok(raw.includes('"// play-reminder-notifications"'));
  assert.ok(raw.includes('"// reminder-notification-freq"'));
});

test('cfgRead cascade: topic value overrides global', () => {
  const cfg = configUtils.loadConfig(GLOBAL);
  const topic = { 'play-notification-sound': false };
  assert.strictEqual(configUtils.cfgRead(topic, cfg, 'play-notification-sound', true), false);
  assert.strictEqual(configUtils.cfgRead(null,  cfg, 'play-notification-sound', true), true);
});

test('cfgRead fallback when key absent everywhere', () => {
  assert.strictEqual(configUtils.cfgRead({}, {}, 'play-reminder-notifications', false), false);
  assert.strictEqual(configUtils.cfgRead({}, {}, 'reminder-notification-freq', 300), 300);
});

test('start-topic strips notification keys via global cascade (keys present in global-config.json)', () => {
  // start-topic.js uses stripGloballyDefinedKeys to exclude any key already in global-config.json.
  // Verify all three notification keys are declared in global-config.json so they auto-strip.
  const cfg = configUtils.loadConfig(GLOBAL);
  assert.ok('play-notification-sound' in cfg, 'play-notification-sound must be in global-config.json');
  assert.ok('play-reminder-notifications' in cfg, 'play-reminder-notifications must be in global-config.json');
  assert.ok('reminder-notification-freq' in cfg, 'reminder-notification-freq must be in global-config.json');
  // Also verify start-topic.js uses the cascade-stripping mechanism.
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'start-topic.js'), 'utf8');
  assert.ok(src.includes('stripGloballyDefinedKeys'), 'start-topic must call stripGloballyDefinedKeys');
});

test('run-agent.js exposes playNotificationSound + reminder loop helpers', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(/function playNotificationSound\(/.test(src));
  assert.ok(/function startClarifyingQuestionWait\(/.test(src));
  assert.ok(/function stopClarifyingQuestionWait\(/.test(src));
  assert.ok(/setInterval\(playNotificationSound,\s*freq\s*\*\s*1000\)/.test(src));
  assert.ok(/process\.on\('exit',\s*stopClarifyingQuestionWait\)/.test(src));
});

test('clarifying-question wait wired into auto-answer-clarifying-questions + manual branches', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  // startClarifyingQuestionWait must run AFTER both autoAnswerClarifyingQuestions and manual append branches,
  // i.e. immediately before promptForUserReply — gates both paths.
  const idxStart = src.indexOf('startClarifyingQuestionWait();');
  const idxPrompt = src.indexOf('await promptForUserReply(');
  assert.ok(idxStart > 0 && idxPrompt > idxStart, 'startClarifyingQuestionWait must precede promptForUserReply');
  assert.ok(src.includes('stopClarifyingQuestionWait();'), 'must stop reminder loop on reply');
});

test('isFinal gate removed: clarifying-question handler runs for final phase too', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  // The old gate `if (!isFinal) { const paused = await handleClarifyingQuestionsIfAny(); ... }`
  // must no longer wrap the call — single-phase pipelines (e.g. `coding`) need to pause too.
  assert.ok(!/if \(!isFinal\)\s*\{\s*const paused = await handleClarifyingQuestionsIfAny/.test(src),
    'final-phase gate still present — coding-only pipeline will skip pause');
  assert.ok(src.includes('handleClarifyingQuestionsIfAny'));
});

test('coding phase re-runs after clarifying-question reply (parity with planning)', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(/phaseName === 'planning' \|\| phaseName === 'coding'/.test(src),
    'coding rerun branch missing — assessment would see only questions');
});

test('platform branch: win32 plays wav via SoundPlayer, else BEL', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(/process\.platform === 'win32'/.test(src));
  assert.ok(/Media\.SoundPlayer/.test(src), 'win32 must use Media.SoundPlayer');
  assert.ok(/'\\x07'/.test(src), 'non-win32 must write BEL char');
});

if (!process.exitCode) console.log('\nAll regression tests passed.');
