#!/usr/bin/env node
'use strict';

/**
 * Tests for src/lib/token-error.js classifyModelAvailabilityError().
 *
 * Run: node Agent_Orchestrator/tests/model-unavailable-error.test.js
 */

const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const { classifyModelAvailabilityError, classifyTransientError } = require(path.join(HARNESS, 'src', 'lib', 'token-error'));

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

const CANARY = 'Error: selected model (gpt-5) may not exist or you may not have access. Run --model to pick a different model.';

test('MU1 — canary phrase -> kind=model-unavailable, model=gpt-5', () => {
  const r = classifyModelAvailabilityError(CANARY);
  assert.strictEqual(r.kind, 'model-unavailable');
  assert.strictEqual(r.model, 'gpt-5');
});

test('MU2 — Run --model hint alone still matches', () => {
  const r = classifyModelAvailabilityError('something else happened. Run --model to pick a different model');
  assert.strictEqual(r.kind, 'model-unavailable');
});

test('MU3 — unrelated stderr -> kind=null', () => {
  const r = classifyModelAvailabilityError('429 too many requests');
  assert.strictEqual(r.kind, null);
});

test('MU4 — empty buffer -> kind=null', () => {
  const r = classifyModelAvailabilityError('');
  assert.strictEqual(r.kind, null);
});

test('MU5 — Error object with canary message -> matches', () => {
  const r = classifyModelAvailabilityError(new Error(CANARY));
  assert.strictEqual(r.kind, 'model-unavailable');
  assert.strictEqual(r.model, 'gpt-5');
});

test('MU6 — canary + noisy 5xx substring; precedence handled by caller, but classifier still matches', () => {
  const buf = `503 service unavailable\n${CANARY}`;
  const ma = classifyModelAvailabilityError(buf);
  const tr = classifyTransientError(buf);
  assert.strictEqual(ma.kind, 'model-unavailable');
  // The transient classifier still matches the 5xx — proves the bug premise that
  // claude-code.js must check model-availability FIRST to avoid burning retries.
  assert.strictEqual(tr.kind, 'transient');
});

// Regression: the exact buffer shape that triggered the original report — a stray
// `429` substring in the SAME stderr/stdout buffer as the canary phrase. The
// caller (`claude-code.js` `on('close')`) MUST classify model-availability BEFORE
// transient, otherwise retry loop burns attempts on a non-retryable failure.
test('MU7 — canary + noisy 429 substring; both classifiers fire, caller-order enforces precedence', () => {
  const buf = `429 too many requests\nupstream noise\n${CANARY}\nmore 429 chatter`;
  const ma = classifyModelAvailabilityError(buf);
  const tr = classifyTransientError(buf);
  assert.strictEqual(ma.kind, 'model-unavailable');
  assert.strictEqual(ma.model, 'gpt-5');
  assert.strictEqual(tr.kind, 'transient');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
