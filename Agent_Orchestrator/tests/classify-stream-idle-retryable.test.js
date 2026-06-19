#!/usr/bin/env node
'use strict';

// Regression: the Claude CLI "Stream idle timeout - partial response received"
// error must classify as TRANSIENT so the pipeline retries with backoff instead
// of die()-ing. This is the exact error that terminated a remediation phase.
//
// Run: node Agent_Orchestrator/tests/classify-stream-idle-retryable.test.js

const path = require('path');
const assert = require('assert');

const TE = path.join(__dirname, '..', 'src', 'lib', 'token-error.js');
const { classifyTransientError, TRANSIENT_REGEX } = require(TE);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${e && (e.message || e)}`); }
}

test('full observed error string classifies as transient', () => {
  const msg = 'API Error: Stream idle timeout - partial response received[coding-agent] still working..';
  assert.strictEqual(classifyTransientError(msg).kind, 'transient');
});

test('"stream idle timeout" alone is transient', () => {
  assert.strictEqual(classifyTransientError('Stream idle timeout').kind, 'transient');
});

test('"partial response received" alone is transient', () => {
  assert.strictEqual(classifyTransientError('partial response received').kind, 'transient');
});

test('classification is case-insensitive', () => {
  assert.strictEqual(classifyTransientError('STREAM IDLE TIMEOUT').kind, 'transient');
});

test('error object (message field) also classifies', () => {
  assert.strictEqual(classifyTransientError({ message: 'Stream idle timeout' }).kind, 'transient');
});

test('regex literally contains the new phrases', () => {
  assert.ok(/stream idle timeout/.test(TRANSIENT_REGEX.source));
  assert.ok(/partial response received/.test(TRANSIENT_REGEX.source));
});

test('unrelated benign line is NOT transient (no over-match)', () => {
  assert.strictEqual(classifyTransientError('coding agent finished cleanly').kind, null);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
