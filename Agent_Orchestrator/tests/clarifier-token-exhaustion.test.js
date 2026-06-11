#!/usr/bin/env node
'use strict';

/**
 * Tests for clarifier-phase token-exhaustion resilience (run-agent.js).
 *
 * (CTE1) classifyTokenError imported in run-agent.js
 * (CTE2) clarifier.pendingReply persisted to topic-config before rerun await
 * (CTE3) monthly spend limit triggers banner + return false (no countdown)
 * (CTE4) rate-limit error during rerun triggers countdown then re-dispatch
 * (CTE5) pendingReply cleared after successful rerun
 * (CTE6) non-token errors propagate (not swallowed)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── (CTE1) classifyTokenError imported ────────────────────────────────────────
test('(CTE1) run-agent.js imports classifyTokenError from lib/token-error', () => {
  assert.ok(
    SRC.includes("require('./lib/token-error')"),
    'run-agent.js must require ./lib/token-error'
  );
  assert.ok(
    SRC.includes('classifyTokenError'),
    'run-agent.js must reference classifyTokenError'
  );
});

// ── (CTE2) pendingReply persisted before rerun await ──────────────────────────
test('(CTE2) clarifier.pendingReply written before runPhase rerun await', () => {
  // Use line-number comparison so formatting changes (split lines, extra spaces) don't
  // produce false positives from raw indexOf on the full source string.
  const lines = SRC.split('\n');
  const persistLine = lines.findIndex(l => l.includes('fresh.clarifier') && l.includes('pendingReply'));
  const rerunLine   = lines.findIndex(l => l.includes('isRerun: true') && l.includes('runPhase'));
  assert.ok(persistLine >= 0, 'pendingReply persist line must exist');
  assert.ok(rerunLine >= 0,   'isRerun:true runPhase call must exist');
  assert.ok(persistLine < rerunLine, 'pendingReply must be persisted BEFORE the rerun await');
});

// ── (CTE3) monthly spend → banner, return false ────────────────────────────────
test('(CTE3) monthly spend limit triggers banner with hresume instruction', () => {
  assert.ok(
    SRC.includes('monthlyCapHit') || SRC.includes("errClass.kind === 'monthly'"),
    'must check monthlyCapHit or errClass.kind==="monthly"'
  );
  assert.ok(
    SRC.includes('Monthly spend limit reached') || SRC.includes('monthly spend limit'),
    'must emit a monthly-spend banner message'
  );
  assert.ok(
    SRC.includes('hresume'),
    'monthly banner must reference hresume command'
  );
});

// ── (CTE4) rate-limit during rerun → countdown + re-dispatch ─────────────────
test('(CTE4) rate-limit during rerun calls handleTokenLimitInline', () => {
  // Verify the catch block checks tokenReset and calls handleTokenLimitInline.
  const catchBlock = SRC.slice(SRC.indexOf('catch (rerunErr)'));
  assert.ok(catchBlock.length > 0, 'catch (rerunErr) block must exist');
  assert.ok(
    catchBlock.includes('rerunErr.tokenReset') && catchBlock.includes('handleTokenLimitInline'),
    'rate-limit branch must read rerunErr.tokenReset and call handleTokenLimitInline'
  );
  assert.ok(
    catchBlock.includes('return false'),
    'rate-limit branch must return false (not re-throw)'
  );
});

// ── (CTE5) pendingReply cleared on success ────────────────────────────────────
test('(CTE5) clarifier.pendingReply cleared after successful rerun', () => {
  assert.ok(
    SRC.includes('delete fresh.clarifier'),
    'pendingReply must be deleted from topic-config after successful rerun'
  );
  // Use line-number comparison (see CTE2 note).
  const lines = SRC.split('\n');
  const deleteLine = lines.findIndex(l => l.includes('delete fresh.clarifier'));
  const rerunLine  = lines.findIndex(l => l.includes('isRerun: true') && l.includes('runPhase'));
  assert.ok(deleteLine >= 0, 'delete fresh.clarifier line must exist');
  assert.ok(rerunLine >= 0,  'isRerun:true runPhase call must exist');
  assert.ok(deleteLine > rerunLine, 'pendingReply delete must be after the rerun call');
});

// ── (CTE6) non-token errors propagate ────────────────────────────────────────
test('(CTE6) non-token errors are re-thrown from the catch block', () => {
  const catchBlock = SRC.slice(SRC.indexOf('catch (rerunErr)'));
  assert.ok(
    catchBlock.includes('throw rerunErr'),
    'non-token errors must be re-thrown so outer handler sees them'
  );
});

// ── (CTE3b) countdown reachable from both normal rate-limit AND clarifier rerun paths ──
test('(CTE3b) handleTokenLimitInline called in ≥2 paths (normal + clarifier-rerun)', () => {
  const calls = (SRC.match(/handleTokenLimitInline\s*\(/g) || []).length;
  assert.ok(
    calls >= 2,
    `handleTokenLimitInline must be called in ≥2 code paths so countdown works in both normal ` +
    `and clarifier-waiting flows. Found ${calls} call(s).`
  );
});

if (_failed > 0) {
  console.error(`\n${_failed} test(s) failed.`);
  process.exit(1);
}
