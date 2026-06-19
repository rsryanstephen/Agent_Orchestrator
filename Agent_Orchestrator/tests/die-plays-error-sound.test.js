#!/usr/bin/env node
'use strict';

// Source-assertion: the central die() helper must fire the error sound before
// exiting, so every fatal-exit path is audible (not just the two ad-hoc catch
// sites). The sound call must be guarded by try/catch so a sound failure cannot
// mask the real error.
//
// Run: node Agent_Orchestrator/tests/die-plays-error-sound.test.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e && (e.message || e)}`);
  }
}

const dieMatch = src.match(/function die\(msg\)\s*\{[^\n]*\}/);
assert.ok(dieMatch, 'die(msg) one-liner must exist');
const dieBody = dieMatch[0];

test('die() body calls playErrorSound', () => {
  assert.ok(dieBody.includes('playErrorSound'), 'die() must call playErrorSound before exit');
});

test('die() guards playErrorSound in try/catch', () => {
  assert.match(dieBody, /try\s*\{\s*playErrorSound\(\)\s*;?\s*\}\s*catch/,
    'playErrorSound must be wrapped in try/catch inside die()');
});

test('die() still exits the process', () => {
  assert.ok(dieBody.includes('process.exit(1)'), 'die() must still process.exit(1)');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
