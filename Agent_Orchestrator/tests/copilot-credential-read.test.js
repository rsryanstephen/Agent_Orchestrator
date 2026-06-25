#!/usr/bin/env node
'use strict';

/**
 * Regression test: COPILOT_GITHUB_TOKEN in process.env allows _authCredentialsExist()
 * to return true without any Credential Manager read (which was dropped).
 *
 * (CR1) _authCredentialsExist returns true when COPILOT_GITHUB_TOKEN env var is set
 * (CR2) _authCredentialsExist returns false when COPILOT_GITHUB_TOKEN is absent (gh not available or not authed)
 * (CR3) _readWindowsCredential and _setWindowsCredentialFn are NOT exported (removed)
 */

const path = require('path');
const assert = require('assert');

const copilotPath = path.join(__dirname, '..', 'src', 'lib', 'providers', 'github-copilot.js');
const copilot = require(copilotPath);

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

test('(CR1) _authCredentialsExist returns true when COPILOT_GITHUB_TOKEN env var is set', () => {
  const origToken = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = 'github_pat_testvalue1234';
  try {
    assert.strictEqual(copilot._authCredentialsExist(), true, 'Expected true when COPILOT_GITHUB_TOKEN is set');
  } finally {
    if (origToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = origToken;
  }
});

test('(CR2) _authCredentialsExist returns false when COPILOT_GITHUB_TOKEN absent and gh unavailable', () => {
  // Only meaningful when gh is not installed or not authenticated.
  // We stub by temporarily setting a bad PATH — skip gracefully if gh IS authed.
  const restoreEnv = clearTokenEnvVars();
  const origPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const result = copilot._authCredentialsExist();
    assert.strictEqual(result, false, 'Expected false with no token and no gh');
  } finally {
    process.env.PATH = origPath;
    restoreEnv();
  }
});

test('(CR3) _readWindowsCredential and _setWindowsCredentialFn not exported', () => {
  assert.strictEqual(copilot._readWindowsCredential, undefined, '_readWindowsCredential must not be exported');
  assert.strictEqual(copilot._setWindowsCredentialFn, undefined, '_setWindowsCredentialFn must not be exported');
});

if (_failed === 0) console.log('\nAll copilot-credential-read tests passed.');
else console.error(`\n${_failed} copilot-credential-read test(s) FAILED.`);
