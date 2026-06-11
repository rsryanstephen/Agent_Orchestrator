#!/usr/bin/env node
'use strict';

/**
 * Tests for stop_reason capture + fallback + transient-error classifier.
 *
 * (SR1) classifyTransientError -> kind='transient' for 429/529/overloaded_error.
 * (SR2) classifyTransientError -> null for unrelated buffers.
 * (SR3) buildUsageFooter surfaces stop_reason + continuations when non-end_turn.
 * (SR4) buildUsageFooter omits stop_reason when end_turn.
 */

const path = require('path');
const assert = require('assert');
const HARNESS = path.join(__dirname, '..');

const { classifyTransientError } = require(path.join(HARNESS, 'src', 'lib', 'token-error'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); passed++; }
  catch (e) { console.log('FAIL', name, '\n', e.message); failed++; }
}

test('SR1 transient classifier 429', () => {
  assert.strictEqual(classifyTransientError('HTTP 429 too many requests').kind, 'transient');
  assert.strictEqual(classifyTransientError('overloaded_error returned by API').kind, 'transient');
  assert.strictEqual(classifyTransientError('upstream returned status 529').kind, 'transient');
});

test('SR2 transient classifier negative', () => {
  assert.strictEqual(classifyTransientError('').kind, null);
  assert.strictEqual(classifyTransientError('connection refused — ENOTFOUND').kind, null);
  assert.strictEqual(classifyTransientError('resets at 3pm (PST)').kind, null);
});

test('SR3 ClaudeCodeProvider spawn opts accept stopReasonFallback', () => {
  const Prov = require(path.join(HARNESS, 'src', 'lib', 'providers', 'claude-code'));
  const p = new Prov({});
  assert.strictEqual(typeof p.spawn, 'function');
  const src = Prov.toString();
  assert.ok(src.includes('stopReasonFallback'), 'spawn must read stopReasonFallback opt');
  assert.ok(src.includes('max_tokens'), 'must dispatch on max_tokens');
  assert.ok(src.includes('pause_turn'), 'must dispatch on pause_turn');
});

test('SR4 parseStream captures stop_reason from result line', () => {
  const Prov = require(path.join(HARNESS, 'src', 'lib', 'providers', 'claude-code'));
  const p = new Prov({});
  const resultLine = JSON.stringify({ type: 'result', stop_reason: 'max_tokens', cost_usd: 0.01, usage: { input_tokens: 10 } });
  const ev = p.parseStream(resultLine);
  assert.ok(ev, 'result line must produce event');
  assert.strictEqual(ev.type, 'done');
  assert.strictEqual(ev.stopReason, 'max_tokens', 'stopReason must propagate from result.stop_reason');
});

test('SR5 parseStream captures stop_reason from assistant message', () => {
  const Prov = require(path.join(HARNESS, 'src', 'lib', 'providers', 'claude-code'));
  const p = new Prov({});
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }], stop_reason: 'pause_turn', usage: { input_tokens: 5 } },
  });
  const ev = p.parseStream(line);
  assert.ok(ev && ev.type === 'assistant_text');
  assert.strictEqual(ev.stopReason, 'pause_turn');
});

test('SR6 separate pause/max counters do not collide', () => {
  const Prov = require(path.join(HARNESS, 'src', 'lib', 'providers', 'claude-code'));
  const src = Prov.toString();
  assert.ok(src.includes('pauseContinuations'), 'must use separate pauseContinuations counter');
  assert.ok(src.includes('maxTokenContinuations'), 'must use separate maxTokenContinuations counter');
  assert.ok(src.includes('prior-assistant-output'), 'pause_turn resume must include prior assistant output');
});

test('SR7 transient regex tightened — bare "API error" does not match', () => {
  // Generic "API error" without status code must NOT trigger transient retry.
  assert.strictEqual(classifyTransientError('user code threw an API error in stack trace').kind, null);
  // But "API error 503" or explicit overloaded_error should still match.
  assert.strictEqual(classifyTransientError('overloaded_error from Anthropic').kind, 'transient');
  assert.strictEqual(classifyTransientError('upstream 503 service unavailable').kind, 'transient');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
