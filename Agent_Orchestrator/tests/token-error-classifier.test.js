#!/usr/bin/env node
'use strict';

/**
 * Tests for src/lib/token-error.js classifyTokenError().
 *
 * Run: node Agent_Orchestrator/tests/token-error-classifier.test.js
 *
 * Coverage:
 *  (TE1) Monthly spend cap string -> kind='monthly'
 *  (TE2) Org monthly spend limit variant -> kind='monthly'
 *  (TE3) Rate-limit string with reset time -> kind='rate' with parsed reset
 *  (TE4) Rate-limit string with am/pm and tz -> kind='rate' with full reset
 *  (TE5) Unrelated error string -> kind=null
 *  (TE6) Empty string -> kind=null
 *  (TE7) Error object with .message (monthly) -> kind='monthly'
 *  (TE8) Error object with .message (rate) -> kind='rate'
 *  (TE9) Monthly cap takes priority over any rate-reset text in same string
 */

const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const { classifyTokenError } = require(path.join(HARNESS, 'src', 'lib', 'token-error'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// TE1
test('TE1 — monthly spend cap string -> kind=monthly', () => {
  const r = classifyTokenError("You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage");
  assert.strictEqual(r.kind, 'monthly');
});

// TE2
test('TE2 — monthly usage limit variant -> kind=monthly', () => {
  const r = classifyTokenError('monthly usage limit exceeded for this organization');
  assert.strictEqual(r.kind, 'monthly');
});

// TE3
test('TE3 — rate-limit with reset time -> kind=rate with reset', () => {
  const r = classifyTokenError('Usage limit exceeded. Session resets at 3pm');
  assert.strictEqual(r.kind, 'rate');
  assert.ok(r.reset, 'reset should be present');
  assert.strictEqual(r.reset.hour, 3);
  assert.strictEqual(r.reset.ampm, 'pm');
});

// TE4
test('TE4 — rate-limit with hour:min and tz -> kind=rate full reset', () => {
  const r = classifyTokenError('Token limit hit. Resets at 11:30 pm (UTC)');
  assert.strictEqual(r.kind, 'rate');
  assert.strictEqual(r.reset.hour, 11);
  assert.strictEqual(r.reset.minute, 30);
  assert.strictEqual(r.reset.ampm, 'pm');
  assert.strictEqual(r.reset.tz, 'UTC');
});

// TE5
test('TE5 — unrelated error -> kind=null', () => {
  const r = classifyTokenError('Claude exited with code 1\nsome unrelated stderr');
  assert.strictEqual(r.kind, null);
});

// TE6
test('TE6 — empty string -> kind=null', () => {
  const r = classifyTokenError('');
  assert.strictEqual(r.kind, null);
});

// TE7
test('TE7 — Error object with monthly message -> kind=monthly', () => {
  const err = new Error("You've hit your org's monthly spend limit");
  const r = classifyTokenError(err);
  assert.strictEqual(r.kind, 'monthly');
});

// TE8
test('TE8 — Error object with rate-limit message -> kind=rate', () => {
  const err = new Error('Usage limit. Resets at 6am');
  const r = classifyTokenError(err);
  assert.strictEqual(r.kind, 'rate');
  assert.strictEqual(r.reset.hour, 6);
});

// TE9 — A parseable reset time wins over "monthly spend limit" wording. Observed in practice:
// the 5-hour session limit surfaces "monthly spend limit" copy yet still exposes a reset time
// (VS Code chat shows the countdown). Treat as rate-limit so the inline countdown + auto-resume
// path runs. Pure monthly cap (no reset) still classifies as monthly (covered by TE1/TE2/TE7).
test('TE9 — reset-time presence wins over monthly-cap phrase', () => {
  const r = classifyTokenError("monthly spend limit hit. Also resets at 5pm (UTC)");
  assert.strictEqual(r.kind, 'rate');
  assert.ok(r.reset);
  assert.strictEqual(r.reset.hour, 5);
  assert.strictEqual(r.reset.ampm, 'pm');
  assert.strictEqual(r.reset.tz, 'UTC');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
