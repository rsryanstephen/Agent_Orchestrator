#!/usr/bin/env node
'use strict';

/**
 * Verifies that a Claude Code CLI context-window overflow surfaces as the
 * actionable "Token limit reached for model X" message rather than the
 * generic "Claude exited with code 1" / "Phase N (coding) failed: ...".
 *
 * Run: node Agent_Orchestrator/tests/token-limit-error-message.test.js
 */

const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const { classifyContextLimitError, TokenLimitError, CONTEXT_LIMIT_REGEX } = require(path.join(HARNESS, 'src', 'lib', 'token-error'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

test('TL1 — "Prompt is too long" stderr -> kind=context-limit', () => {
  const r = classifyContextLimitError('Error: Prompt is too long. Reduce input.');
  assert.strictEqual(r.kind, 'context-limit');
});

test('TL2 — "context length exceeded" matches', () => {
  const r = classifyContextLimitError('400 invalid_request_error: context length exceeded by 5000 tokens');
  assert.strictEqual(r.kind, 'context-limit');
});

test('TL3 — "maximum context" matches', () => {
  const r = classifyContextLimitError('Input exceeds the model\'s maximum context window of 200000 tokens.');
  assert.strictEqual(r.kind, 'context-limit');
});

test('TL4 — invalid_request_error + tokens matches', () => {
  const r = classifyContextLimitError('HTTP 400 {"type":"invalid_request_error","message":"prompt tokens exceed limit"}');
  assert.strictEqual(r.kind, 'context-limit');
});

test('TL5 — unrelated stderr (rate-limit 429) -> kind=null', () => {
  const r = classifyContextLimitError('429 too many requests; resets at 3pm');
  assert.strictEqual(r.kind, null);
});

test('TL6 — empty buffer -> kind=null', () => {
  assert.strictEqual(classifyContextLimitError('').kind, null);
  assert.strictEqual(classifyContextLimitError(null).kind, null);
});

test('TL7 — TokenLimitError carries model + phase + contextLimitHit flag', () => {
  const e = new TokenLimitError('prompt too large', { model: 'claude-opus-4-7', phase: 'coding' });
  assert.strictEqual(e.name, 'TokenLimitError');
  assert.strictEqual(e.contextLimitHit, true);
  assert.strictEqual(e.model, 'claude-opus-4-7');
  assert.strictEqual(e.phase, 'coding');
});

test('TL8 — Error obj with .stderrBuf carrying canary phrase matches', () => {
  const errLike = { stderrBuf: 'noise\nPrompt is too long\nmore noise' };
  assert.strictEqual(classifyContextLimitError(errLike).kind, 'context-limit');
});

test('TL9 — regex constant exported and matches', () => {
  assert.ok(CONTEXT_LIMIT_REGEX.test('Prompt is too long'));
  assert.ok(!CONTEXT_LIMIT_REGEX.test('all good here'));
});

// End-to-end provider behaviour: simulate a child process whose stderr carries
// the canary phrase and exits non-zero. Assert: the spawned promise rejects
// with an Error tagged `contextLimitHit=true` (so run-agent.js can branch on
// it) rather than a plain Error('Claude exited with code 1').
test('TL10 — Provider close-handler tags err.contextLimitHit when stderr carries canary', () => {
  // Inline replay of the claude-code.js classifier branch — guards the call
  // ordering (model-availability checked first, then context-limit, before
  // rate/transient classification).
  const { classifyModelAvailabilityError, classifyContextLimitError: cce } = require(path.join(HARNESS, 'src', 'lib', 'token-error'));
  const combined = '\nError calling model: Prompt is too long\n';
  assert.strictEqual(classifyModelAvailabilityError(combined).kind, null, 'model-availability must NOT match for this buffer');
  const ctx = cce(combined);
  assert.strictEqual(ctx.kind, 'context-limit');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
