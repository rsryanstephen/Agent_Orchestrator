#!/usr/bin/env node
'use strict';

// Regression: `run-parallel.js` must bridge `*-sound-file` config overrides into
// `AMA_SOUND_*` env vars before spawning the multi-job broker, so a user's custom
// sound reaches broker-played chimes (which run with no topic config in scope).
// It must forward any non-empty `.wav` path value (the broker's `_playEvent`
// plays it); non-string/blank values must be skipped. It must also set
// `AMA_SUPPRESS_CLARIFYING=1` when `auto-answer-clarifying-questions-and-submit`
// is on so the broker's clarifying chime stays silent.
//
// BEHAVIOURAL (no source-grep): drives the exported `exportSoundOverridesToEnv`
// with a fake config + throwaway env target and asserts the actual mappings the
// broker would inherit. Verifies the requirement's behaviour, not its source text,
// so a wiring refactor that preserves the mapping keeps this test green.
//
// Run: node Agent_Orchestrator/tests/broker-sound-override-env-bridge.test.js

const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
// require() must NOT run the CLI — guarded behind require.main === module.
const { exportSoundOverridesToEnv } = require(path.join(HARNESS, 'src', 'run-parallel.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e && (e.message || e)}`); }
}

test('module require() does not spawn the CLI (export seam exists)', () => {
  assert.strictEqual(typeof exportSoundOverridesToEnv, 'function',
    'run-parallel.js must export exportSoundOverridesToEnv');
});

test('all five sound config keys map to their AMA_SOUND_* env vars', () => {
  const env = {};
  exportSoundOverridesToEnv({
    'clarifying-sound-file': 'C:/Windows/Media/Alarm01.wav',
    'queue-fetch-sound-file': 'C:/Windows/Media/notify.wav',
    'completion-sound-file': 'C:/Windows/Media/tada.wav',
    'token-limit-sound-file': 'C:/Windows/Media/Windows Notify Messaging.wav',
    'error-sound-file': 'C:/Windows/Media/Windows Critical Stop.wav',
  }, env);
  assert.strictEqual(env.AMA_SOUND_CLARIFYING, 'C:/Windows/Media/Alarm01.wav');
  assert.strictEqual(env.AMA_SOUND_QUEUE_FETCH, 'C:/Windows/Media/notify.wav');
  assert.strictEqual(env.AMA_SOUND_COMPLETION, 'C:/Windows/Media/tada.wav');
  assert.strictEqual(env.AMA_SOUND_TOKEN_LIMIT, 'C:/Windows/Media/Windows Notify Messaging.wav');
  assert.strictEqual(env.AMA_SOUND_ERROR, 'C:/Windows/Media/Windows Critical Stop.wav');
});

test('forwards .wav path overrides', () => {
  const env = {};
  exportSoundOverridesToEnv({ 'clarifying-sound-file': 'C:/sounds/ding.wav' }, env);
  assert.strictEqual(env.AMA_SOUND_CLARIFYING, 'C:/sounds/ding.wav',
    'a .wav path override must reach the broker via AMA_SOUND_*');
});

test('trims surrounding whitespace from a forwarded path', () => {
  const env = {};
  exportSoundOverridesToEnv({ 'completion-sound-file': '  C:/x/done.wav  ' }, env);
  assert.strictEqual(env.AMA_SOUND_COMPLETION, 'C:/x/done.wav');
});

test('sets AMA_SUPPRESS_CLARIFYING when auto-answer-and-submit is on', () => {
  const env = {};
  exportSoundOverridesToEnv({ 'auto-answer-clarifying-questions-and-submit': true }, env);
  assert.strictEqual(env.AMA_SUPPRESS_CLARIFYING, '1');
  const env2 = {};
  exportSoundOverridesToEnv({ 'auto-answer-clarifying-questions-and-submit': false }, env2);
  assert.strictEqual(env2.AMA_SUPPRESS_CLARIFYING, undefined,
    'flag must NOT be set when auto-submit is off');
});

test('non-string / missing config values are ignored (no throw, no leak)', () => {
  const env = {};
  exportSoundOverridesToEnv({ 'clarifying-sound-file': 12345, 'error-sound-file': null }, env);
  assert.deepStrictEqual(env, {}, 'non-string values must not be forwarded');
});

test('missing/empty config is non-fatal and writes nothing', () => {
  const env = {};
  exportSoundOverridesToEnv({}, env);
  assert.deepStrictEqual(env, {});
  // undefined config (no arg) falls back to real global-config load — must not throw.
  assert.doesNotThrow(() => exportSoundOverridesToEnv(undefined, {}));
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
