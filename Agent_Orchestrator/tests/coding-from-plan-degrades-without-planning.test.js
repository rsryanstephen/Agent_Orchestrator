#!/usr/bin/env node
'use strict';

// Source-assertion: runCodingFromPlan must NOT hard-fail (die) when the planning
// section is missing. It must fall back to parseConversationContext so the coding
// phase still runs. Guards against the observed silent coding-phase abort.
//
// Run: node Agent_Orchestrator/tests/coding-from-plan-degrades-without-planning.test.js

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

// Isolate the runCodingFromPlan body for scoped assertions.
const startIdx = src.indexOf('async function runCodingFromPlan');
assert.ok(startIdx !== -1, 'runCodingFromPlan must exist');
const endIdx = src.indexOf('async function runCoding(', startIdx);
assert.ok(endIdx !== -1, 'runCoding must follow runCodingFromPlan');
const body = src.slice(startIdx, endIdx);

test('runCodingFromPlan does NOT unconditionally die on null plan', () => {
  // The old failing pattern: `if (!plan) die(...)`. Must no longer exist.
  assert.ok(
    !/if\s*\(\s*!plan\s*\)\s*die\(/.test(body),
    'runCodingFromPlan must not bare-die() when plan is null — it must degrade gracefully'
  );
});

test('runCodingFromPlan warns and falls back when plan missing', () => {
  assert.ok(
    /if\s*\(\s*!plan\s*\)\s*log\(/.test(body),
    'missing plan must produce a [WARN] log, not a die'
  );
});

test('runCodingFromPlan references parseConversationContext fallback', () => {
  assert.ok(
    body.includes('parseConversationContext(historyPath)'),
    'fallback must use parseConversationContext(historyPath)'
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
