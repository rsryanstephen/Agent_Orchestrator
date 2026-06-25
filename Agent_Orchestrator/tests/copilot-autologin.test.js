#!/usr/bin/env node
'use strict';

/**
 * Unit tests for github-copilot.js auth-probe functions.
 * Follows the copilot-smoke.test.js pattern: plain Node.js, no Jest.
 *
 * (CA4) probe() returns false when credentials absent (env unset, gh unavailable)
 * (CA5) autoLogin, isBinaryInstalled, _authCredentialsExist all exported
 * (CA6) registry.js source calls isBinaryInstalled after probe failure (static text assertion)
 * (CA7) _authCredentialsExist returns true when COPILOT_GITHUB_TOKEN env var is set
 * (CA8) _authCredentialsExist exports token from gh auth token into COPILOT_GITHUB_TOKEN
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const HARNESS = path.join(__dirname, '..');
const copilotPath = path.join(HARNESS, 'src', 'lib', 'providers', 'github-copilot.js');
const registryPath = path.join(HARNESS, 'src', 'lib', 'providers', 'registry.js');

function clearTokenEnvVars() {
  const saved = {
    COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  delete process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  return () => {
    if (saved.COPILOT_GITHUB_TOKEN !== undefined) process.env.COPILOT_GITHUB_TOKEN = saved.COPILOT_GITHUB_TOKEN;
    else delete process.env.COPILOT_GITHUB_TOKEN;
    if (saved.GH_TOKEN !== undefined) process.env.GH_TOKEN = saved.GH_TOKEN;
    if (saved.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
  };
}

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

if (!fs.existsSync(copilotPath)) {
  console.warn('[skip] github-copilot.js not found — copilot-autologin tests skipped.');
  process.exit(0);
}

const copilot = require(copilotPath);

test('(CA4) probe() returns false when credentials absent and gh unavailable', () => {
  const restoreEnv = clearTokenEnvVars();
  const origPath = process.env.PATH;
  process.env.PATH = '';
  try {
    // probe() = isBinaryInstalled() && _authCredentialsExist().
    // With no token env vars and no gh, _authCredentialsExist() returns false.
    assert.strictEqual(copilot._authCredentialsExist(), false, 'Expected _authCredentialsExist() false with no creds');
    // probe() is a superset — also requires binary; either way result must be false.
    assert.strictEqual(copilot.probe(), false, 'Expected probe() === false when credentials absent');
  } finally {
    process.env.PATH = origPath;
    restoreEnv();
  }
});

test('(CA5) autoLogin, isBinaryInstalled, _authCredentialsExist all exported', () => {
  assert.strictEqual(typeof copilot.autoLogin, 'function', 'autoLogin must be a function export');
  assert.strictEqual(typeof copilot.isBinaryInstalled, 'function', 'isBinaryInstalled must be a function export');
  assert.strictEqual(typeof copilot._authCredentialsExist, 'function', '_authCredentialsExist must be a function export');
});

test('(CA6) registry.js calls isBinaryInstalled after probe failure', () => {
  assert.ok(fs.existsSync(registryPath), 'registry.js must exist');
  const src = fs.readFileSync(registryPath, 'utf8');
  assert.ok(src.includes('isBinaryInstalled'), 'registry.js must reference isBinaryInstalled');
  assert.ok(src.includes('probe'), 'registry.js must call probe()');
  const probeIdx = src.indexOf('probe');
  const binIdx = src.indexOf('isBinaryInstalled');
  assert.ok(binIdx > probeIdx, 'isBinaryInstalled reference must appear after probe() in registry.js');
});

test('(CA7) _authCredentialsExist returns true when COPILOT_GITHUB_TOKEN env var is set', () => {
  const origToken = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = 'github_pat_faketoken123';
  try {
    assert.strictEqual(copilot._authCredentialsExist(), true, 'Expected true when COPILOT_GITHUB_TOKEN is set');
  } finally {
    if (origToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = origToken;
  }
});

test('(CA8) _authCredentialsExist exports gh auth token into COPILOT_GITHUB_TOKEN when available', () => {
  // Only run this test if gh is actually installed and authenticated.
  const ghCheck = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (ghCheck.status !== 0 || !ghCheck.stdout.trim()) {
    console.log('SKIP (CA8): gh not installed or not authenticated — skipping gh fallback test');
    return;
  }
  const expectedToken = ghCheck.stdout.trim();
  const restoreEnv = clearTokenEnvVars();
  try {
    const result = copilot._authCredentialsExist();
    assert.strictEqual(result, true, 'Expected _authCredentialsExist() true when gh is authenticated');
    assert.strictEqual(process.env.COPILOT_GITHUB_TOKEN, expectedToken, 'Expected COPILOT_GITHUB_TOKEN to be set from gh auth token');
  } finally {
    restoreEnv();
  }
});

if (_failed === 0) console.log('\nAll copilot-autologin tests passed.');
else console.error(`\n${_failed} copilot-autologin test(s) FAILED.`);
