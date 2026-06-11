#!/usr/bin/env node
'use strict';

/**
 * Tests confirming --probe handler in run-agent.js dispatches through
 * getProvider(providerId).probe() rather than hardcoding a binary name.
 *
 * (PD1) run-agent.js --probe block calls provider.probe() not spawnSync(bin, ['--version'])
 * (PD2) --probe block calls provider.loginInstructions() on failure
 * (PD3) --probe block does not contain hardcoded 'copilot' or 'claude' binary decision tree
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

// Extract the --probe block.
const probeBlockMatch = SRC.match(/if \(process\.argv\[2\] === '--probe'\) \{([\s\S]*?)\n\}/);

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('(PD1) --probe block calls provider.probe()', () => {
  assert.ok(probeBlockMatch, 'Could not locate --probe block in run-agent.js');
  const block = probeBlockMatch[1];
  assert.ok(/provider\.probe\(\)/.test(block), '--probe block must call provider.probe()');
});

test('(PD2) --probe block calls provider.loginInstructions() on failure', () => {
  assert.ok(probeBlockMatch, 'Could not locate --probe block in run-agent.js');
  const block = probeBlockMatch[1];
  assert.ok(/provider\.loginInstructions\(\)/.test(block), '--probe block must call provider.loginInstructions()');
});

test('(PD3) --probe block does not hardcode binary decision (copilot vs claude)', () => {
  assert.ok(probeBlockMatch, 'Could not locate --probe block in run-agent.js');
  const block = probeBlockMatch[1];
  // Must not contain the old: const bin = providerId === 'github-copilot' ? 'copilot' : 'claude'
  assert.ok(
    !/bin\s*=\s*providerId\s*===/.test(block),
    '--probe must not contain hardcoded binary decision tree'
  );
});

if (_failed === 0) console.log('\nAll probe-dispatch tests passed.');
else console.error(`\n${_failed} probe-dispatch test(s) FAILED.`);
