#!/usr/bin/env node
'use strict';

// Regression: the in-process `flushEditorBuffers` in run-agent.js must honour the
// cross-process HARNESS_EDITOR_FLUSHED guard for NON-force calls, so a child
// spawned after an entry-point flush does not re-fire the keystroke chord (double
// focus-steal + double Ctrl+K S per hrun). Forced calls (drain / interactive
// boundaries) must still bypass the guard. Source-string assertions — the
// function is not exported.
//
// Run: node Agent_Orchestrator/tests/run-agent-flush-honors-flushed-env.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RUN_AGENT = path.join(__dirname, '..', 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, '\n', e.stack || e.message); }
}

// Slice the flushEditorBuffers body up to the next top-level function (avoids
// brace-matching the template/destructured braces inside it).
function flushBody() {
  const start = src.indexOf('function flushEditorBuffers(');
  assert.ok(start >= 0, 'flushEditorBuffers declaration not found');
  const nextRe = /\n(?:async\s+)?function\s/g;
  nextRe.lastIndex = start + 'function flushEditorBuffers('.length;
  const m = nextRe.exec(src);
  return src.slice(start, m ? m.index : src.length);
}

test('FLUSHED_ENV is imported from editor-buffer-flush.js (single source of truth)', () => {
  assert.ok(/require\(['"]\.\/editor-buffer-flush['"]\)/.test(src), 'must require editor-buffer-flush');
  assert.ok(/\bFLUSHED_ENV\b/.test(src), 'must reference FLUSHED_ENV');
});

test('non-force flush is gated on FLUSHED_ENV before flushing', () => {
  const body = flushBody();
  const guard = body.indexOf("process.env[FLUSHED_ENV] === '1'");
  assert.ok(guard >= 0, 'must check process.env[FLUSHED_ENV] === "1"');
  // Guard must be a non-force early-return, ordered before the keystroke flush.
  assert.ok(/!force\s*&&\s*process\.env\[FLUSHED_ENV\]\s*===\s*'1'\)\s*return/.test(body),
    'guard must be `if (!force && process.env[FLUSHED_ENV] === "1") return;`');
  const keystroke = body.indexOf('flushViaKeystroke(');
  assert.ok(guard < keystroke, 'guard must precede the keystroke flush');
});

test('flush sets FLUSHED_ENV so children inherit it', () => {
  const body = flushBody();
  const sets = (body.match(/process\.env\[FLUSHED_ENV\]\s*=\s*'1'/g) || []).length;
  assert.ok(sets >= 1, `expected the keystroke flush path to set FLUSHED_ENV, found ${sets}`);
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
