#!/usr/bin/env node
'use strict';

/**
 * Tests for src/lib/token-error.js classifyTokensExhausted().
 *
 * Run: node Agent_Orchestrator/tests/provider-token-exhausted-fallback.test.js
 *
 * Covers the durable requirement (backup
 * `topic_files/claude_harness/backups/claude_harness.archive-2026-06-12T17-00-07.md:2518`):
 * cross-provider token-exhaustion fallback. The harness must detect that the
 * active provider has exhausted its quota/token window so run-agent.js can walk
 * the configured `fallback-providers` chain ("Tokens have run out on X. Falling
 * back to Y."). `classifyTokensExhausted` is the requireable detection seam that
 * gates that swap; this regression test fails if detection is removed/broken.
 *
 * Coverage:
 *  (PE1) "tokens have run out" stderr -> kind='tokens-exhausted'
 *  (PE2) Gemini-style "resource_exhausted" -> kind='tokens-exhausted'
 *  (PE3) Copilot-style "premium request" / quota exceeded -> kind='tokens-exhausted'
 *  (PE4) Explicit object flag { tokensExhausted: true } -> kind='tokens-exhausted'
 *  (PE5) Unrelated stderr -> kind=null (no spurious provider swap)
 *  (PE6) Empty input -> kind=null
 */

const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const { classifyTokensExhausted } = require(path.join(HARNESS, 'src', 'lib', 'token-error'));

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

// PE1
test('PE1 — "tokens have run out" -> kind=tokens-exhausted', () => {
  const r = classifyTokensExhausted('Error: tokens have run out for this subscription');
  assert.strictEqual(r.kind, 'tokens-exhausted');
});

// PE2
test('PE2 — gemini resource_exhausted -> kind=tokens-exhausted', () => {
  const r = classifyTokensExhausted('RESOURCE_EXHAUSTED: quota exceeded for the day');
  assert.strictEqual(r.kind, 'tokens-exhausted');
});

// PE3
test('PE3 — copilot premium request limit -> kind=tokens-exhausted', () => {
  const r = classifyTokensExhausted('You have reached your monthly request limit (premium request)');
  assert.strictEqual(r.kind, 'tokens-exhausted');
});

// PE4
test('PE4 — explicit tokensExhausted flag on error object -> kind=tokens-exhausted', () => {
  const r = classifyTokensExhausted({ tokensExhausted: true, message: 'spawn failed' });
  assert.strictEqual(r.kind, 'tokens-exhausted');
});

// PE5
test('PE5 — unrelated stderr -> kind=null', () => {
  const r = classifyTokensExhausted('Claude exited with code 1\nunrelated stack trace');
  assert.strictEqual(r.kind, null);
});

// PE6
test('PE6 — empty input -> kind=null', () => {
  assert.strictEqual(classifyTokensExhausted('').kind, null);
  assert.strictEqual(classifyTokensExhausted(null).kind, null);
});

console.log(`\nprovider-token-exhausted-fallback: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
