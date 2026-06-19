#!/usr/bin/env node
'use strict';

// Tests for model-catalog availability helpers (Step 1).
// Injects a fixture cache via MODEL_CATALOG_CACHE_PATH and asserts:
//   - unknown model id => {available:false}
//   - known model id   => {available:true}
//   - missing cache    => {stale:true, available:false}
// Run: node Agent_Orchestrator/tests/model-catalog-availability.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Stage a fixture cache file in a temp dir BEFORE requiring the module so the
// env-var-driven CACHE_PATH resolves to the fixture.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcat-'));
const fixturePath = path.join(tmpDir, 'cache.json');
const fixture = {
  fetchedAt: Date.now(),
  providers: {
    'github-copilot': {
      models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
      tiers:  { heavy: 'gpt-4.1', medium: 'gpt-4.1', light: 'gpt-4.1-mini' },
    },
  },
};
fs.writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');
process.env.MODEL_CATALOG_CACHE_PATH = fixturePath;

// Clear any prior require so the env var takes effect on first load.
const modPath = require.resolve('../src/lib/model-catalog.js');
delete require.cache[modPath];
const { isModelAvailable } = require('../src/lib/model-catalog.js');

test('isModelAvailable: unknown id "gpt-5.4" reports available=false', () => {
  const r = isModelAvailable('github-copilot', 'gpt-5.4');
  assert.strictEqual(r.available, false, 'expected available=false for unknown id');
  assert.strictEqual(r.stale, false, 'fixture cache is fresh');
  assert.ok(Array.isArray(r.knownList) && r.knownList.includes('gpt-4.1'), 'knownList must surface real cache entries');
});

test('isModelAvailable: known id "gpt-4.1" reports available=true', () => {
  const r = isModelAvailable('github-copilot', 'gpt-4.1');
  assert.strictEqual(r.available, true, 'expected available=true for cached id');
  assert.strictEqual(r.stale, false);
});

test('isModelAvailable: missing provider returns stale=true', () => {
  const r = isModelAvailable('claude-code', 'claude-opus-4-8');
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.stale, true, 'no provider entry => stale');
});

test('module exports the new helpers', () => {
  const m = require('../src/lib/model-catalog.js');
  assert.strictEqual(typeof m.isModelAvailable, 'function');
  assert.strictEqual(typeof m.ensureFreshCache, 'function');
});

// Cleanup fixture on exit (best-effort).
process.on('exit', () => {
  try { fs.unlinkSync(fixturePath); fs.rmdirSync(tmpDir); } catch {}
});
