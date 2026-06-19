#!/usr/bin/env node
'use strict';

// Regression tests for per-topic topic-config.json cascade override via cfgRead.
// Run: node Agent_Orchestrator/tests/config-cascade.test.js
//
// Covers:
//  (1)  cfgRead: topic-config overrides global-config for the same key
//  (2)  cfgRead: global-config is used as fallback when topic-config is null
//  (3)  cfgRead: fallback default returned when neither config has the key
//  (4)  cfgRead: kebab key in topic-config resolved (no camelCase-only assumption)
//  (5)  cfgRead: camelCase alias resolves kebab key from global-config
//  (6)  editor-save-all-command: run-agent.js reads via cfgRead with legacy vscode-save-all-command fallback
//  (7)  editor-save-flush-ms: run-agent.js reads via cfgRead with legacy vscode-save-flush-ms fallback
//  (8)  network-retry: cfgRead resolves per-topic override for maxAttempts + backoffMs
//  (9)  auto-answer-clarifying-questions: per-topic topic-config.json cascade
// (10)  auto-answer-clarifying-questions-and-submit: per-topic cascade, independent of global value

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS      = path.join(__dirname, '..');
const configUtils  = require(path.join(HARNESS, 'src', 'config-utils.js'));
const runAgentSrc  = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
const globalCfg    = configUtils.loadConfig(configUtils.globalConfigPath());

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

function tmpCfg(obj) {
  const p = path.join(os.tmpdir(), `cfg-cascade-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  const loaded = configUtils.loadConfig(p);
  try { fs.unlinkSync(p); } catch {}
  return loaded;
}

// ── (1) topic overrides global ────────────────────────────────────────────────
test('(1) cfgRead: topic-config value takes precedence over global-config', () => {
  const topic  = tmpCfg({ 'output-verbosity': 1 });
  const global = tmpCfg({ 'output-verbosity': 5 });
  const v = configUtils.cfgRead(topic, global, 'output-verbosity', 99);
  assert.strictEqual(v, 1, 'topic-config must override global-config');
});

// ── (2) global fallback when topic is null ────────────────────────────────────
test('(2) cfgRead: global-config value used when topicConfig is null', () => {
  const global = tmpCfg({ 'output-verbosity': 3 });
  const v = configUtils.cfgRead(null, global, 'output-verbosity', 99);
  assert.strictEqual(v, 3, 'global-config must be used when topicConfig is null');
});

// ── (3) fallback default when neither config has key ──────────────────────────
test('(3) cfgRead: fallback default returned when neither config has the key', () => {
  const topic  = tmpCfg({ 'some-other-key': true });
  const global = tmpCfg({ 'another-key': false });
  const v = configUtils.cfgRead(topic, global, 'non-existent-key', 'MY_DEFAULT');
  assert.strictEqual(v, 'MY_DEFAULT', 'fallback default must be returned when key absent');
});

// ── (4) kebab key in topic-config resolved ────────────────────────────────────
test('(4) cfgRead: kebab-case key in topic-config.json is resolved correctly', () => {
  const topic  = tmpCfg({ 'auto-context': false });
  const global = tmpCfg({ 'auto-context': true });
  const v = configUtils.cfgRead(topic, global, 'auto-context', true);
  assert.strictEqual(v, false, 'kebab key in topic-config must resolve correctly');
});

// ── (5) camelCase alias resolves kebab key ────────────────────────────────────
test('(5) cfgRead: camelCase alias in global-config surfaces via kebab-key lookup', () => {
  // aliasKebabKeys adds non-enumerable camelCase getters for all kebab keys.
  const global = tmpCfg({ 'max-context-lifespan': 7 });
  const v = configUtils.cfgRead(null, global, 'max-context-lifespan', 5);
  assert.strictEqual(v, 7, 'max-context-lifespan must resolve via cfgRead');
});

// (6)/(7) REMOVED: the editor save-all flush is now hardcoded and
// non-configurable — run-agent.js no longer reads `editor-save-all-command` /
// `editor-save-flush-ms` (or the legacy `vscode-save-*` aliases) via cfgRead.
// See editor-flush-hardcoded-no-config.test.js for the hardcoded contract.

// ── (8) network-retry: per-topic cascade ──────────────────────────────────────
test('(8) cfgRead: per-topic network-retry.maxAttempts overrides global', () => {
  const topicRetry  = { 'network-retry': { maxAttempts: 2, backoffMs: [500] } };
  const globalRetry = { 'network-retry': { maxAttempts: 5, backoffMs: [1000, 4000] } };
  const topic  = tmpCfg(topicRetry);
  const global = tmpCfg(globalRetry);
  const r = configUtils.cfgRead(topic, global, 'network-retry', {});
  assert.strictEqual(r.maxAttempts, 2,
    'per-topic network-retry.maxAttempts must override global value');
  assert.deepStrictEqual(r.backoffMs, [500],
    'per-topic network-retry.backoffMs must override global value');
});

// ── (9) auto-answer-clarifying-questions per-topic cascade ────────────────────
test('(9) cfgRead: per-topic auto-answer-clarifying-questions overrides global', () => {
  // Global has true, topic overrides to false.
  const topic  = tmpCfg({ 'auto-answer-clarifying-questions': false });
  const global = tmpCfg({ 'auto-answer-clarifying-questions': true });
  const v = configUtils.cfgRead(topic, global, 'auto-answer-clarifying-questions', null);
  assert.strictEqual(v, false, 'topic-config must override global for auto-answer-clarifying-questions');
});

// ── (10) auto-answer-clarifying-questions-and-submit per-topic cascade ─────────
test('(10) cfgRead: per-topic auto-answer-clarifying-questions-and-submit overrides global', () => {
  // Global false, topic enables it.
  const topic  = tmpCfg({ 'auto-answer-clarifying-questions-and-submit': true });
  const global = tmpCfg({ 'auto-answer-clarifying-questions-and-submit': false });
  const v = configUtils.cfgRead(topic, global, 'auto-answer-clarifying-questions-and-submit', null);
  assert.strictEqual(v, true,
    'topic-config must override global for auto-answer-clarifying-questions-and-submit');

  // Verify it is truly independent: a topic with only the base key does NOT
  // accidentally enable the -and-submit variant.
  const topic2  = tmpCfg({ 'auto-answer-clarifying-questions': true });
  const global2 = tmpCfg({ 'auto-answer-clarifying-questions-and-submit': false });
  const v2 = configUtils.cfgRead(topic2, global2, 'auto-answer-clarifying-questions-and-submit', null);
  assert.strictEqual(v2, false,
    'enabling auto-answer must not implicitly enable -and-submit via cascade');
});

// ── Bonus: global-config.json declares both keys with correct defaults ─────────
test('(B1) global-config.json has auto-answer-clarifying-questions and -and-submit with expected defaults', () => {
  const aaVal   = configUtils.cfgRead(null, globalCfg, 'auto-answer-clarifying-questions');
  const aaasVal = configUtils.cfgRead(null, globalCfg, 'auto-answer-clarifying-questions-and-submit');
  assert.ok(typeof aaVal === 'boolean',
    'auto-answer-clarifying-questions must be a boolean in global-config.json');
  assert.strictEqual(aaasVal, false,
    'auto-answer-clarifying-questions-and-submit default must be false (safe default)');
});

if (_failed === 0) console.log('\nAll config-cascade tests passed.');
