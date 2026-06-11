#!/usr/bin/env node
'use strict';

// Regression: aliasKebabKeys must provide bidirectional aliases so that
// topicConfig.contextFiles === topicConfig['context-files'] regardless of
// which form the JSON uses.
// Run: node Agent_Orchestrator/tests/context-files-alias.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS     = path.join(__dirname, '..');
const configUtils = require(path.join(HARNESS, 'src', 'config-utils.js'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

function tmpCfg(obj) {
  const p = path.join(os.tmpdir(), `ctx-alias-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  const loaded = configUtils.loadConfig(p);
  try { fs.unlinkSync(p); } catch {}
  return loaded;
}

const SAMPLE = [{ path: 'Agent_Orchestrator/src', age: 0 }, { path: 'Agent_Orchestrator/tests', age: 0 }];

// (1) kebab-only JSON: camelCase alias returns same array
test('(1) kebab context-files -> contextFiles alias returns same array', () => {
  const cfg = tmpCfg({ 'context-files': SAMPLE });
  assert.ok(Array.isArray(cfg['context-files']), 'context-files must be an array');
  assert.strictEqual(cfg.contextFiles, cfg['context-files'],
    'cfg.contextFiles must be === cfg["context-files"]');
  assert.deepStrictEqual(cfg.contextFiles, SAMPLE,
    'contextFiles must equal original array contents');
});

// (2) camelCase-only JSON: kebab alias returns same array
test('(2) camelCase contextFiles -> context-files alias returns same array', () => {
  const cfg = tmpCfg({ contextFiles: SAMPLE });
  assert.ok(Array.isArray(cfg.contextFiles), 'contextFiles must be an array');
  assert.strictEqual(cfg['context-files'], cfg.contextFiles,
    'cfg["context-files"] must be === cfg.contextFiles');
  assert.deepStrictEqual(cfg['context-files'], SAMPLE,
    'context-files alias must equal original array contents');
});

// (3) setter propagates through alias
test('(3) writing via camelCase alias visible on kebab key', () => {
  const cfg = tmpCfg({ 'context-files': SAMPLE });
  const updated = [{ path: 'new/path', age: 1 }];
  cfg.contextFiles = updated;
  assert.strictEqual(cfg['context-files'], updated,
    'assigning via camelCase alias must update the kebab key');
});

if (_failed === 0) console.log('\nAll context-files-alias tests passed.');
