#!/usr/bin/env node
'use strict';

// Regression for the inline auto-resume bug: `handleTokenLimitInline` referenced
// an undeclared `signalFired` (`if (signalFired) return;`) just before the
// in-process resume call. On every session reset this threw
// `ReferenceError: signalFired is not defined`, was caught downstream, and
// surfaced as "Inline resume failed" — blocking auto-resume entirely.
//
// `handleTokenLimitInline` is module-scoped (no export) and exits the process on
// completion paths, so it cannot be driven directly in-process. The regression
// is therefore pinned two ways:
//   (1) the undeclared symbol must be GONE from run-agent.js source (the exact
//       failing pattern — before the fix grep returned >=1 hit), and
//   (2) control after the SIGINT/SIGHUP teardown must fall straight through to
//       the `runPipeline(...)` resume call with no intervening guard reference.
//
// Run: node Agent_Orchestrator/tests/inline-resume-signalfired-regression.test.js

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

const HARNESS   = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const src       = fs.readFileSync(RUN_AGENT, 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// (1) Scoped regression guard: the undeclared `signalFired` must not reappear
//     INSIDE handleTokenLimitInline (where it threw). A whole-file ban was too
//     tight — it permanently forbade a legitimate future signal-fired flag
//     elsewhere — so the check is narrowed to the offending function body.
test('handleTokenLimitInline body contains zero `signalFired` references (undeclared symbol removed)', () => {
  const fnStart = src.indexOf('async function handleTokenLimitInline');
  assert.ok(fnStart !== -1, 'handleTokenLimitInline must exist');
  const fnBody = src.slice(fnStart, fnStart + 3600);
  const hits = fnBody.match(/signalFired/g) || [];
  assert.strictEqual(hits.length, 0,
    `expected 0 occurrences of signalFired in handleTokenLimitInline, found ${hits.length} — the undeclared guard reintroduces ReferenceError`);
});

// (2) Within handleTokenLimitInline, the SIGINT teardown must be immediately
//     followed by the resume path (no guard line referencing an undeclared var
//     between the `process.off('SIGINT', ...)` and the `runPipeline(...)` call).
test('handleTokenLimitInline falls through to runPipeline resume after signal teardown', () => {
  const fnStart = src.indexOf('async function handleTokenLimitInline');
  assert.ok(fnStart !== -1, 'handleTokenLimitInline must exist');
  const fnBody = src.slice(fnStart, fnStart + 3600);
  assert.ok(/runPipeline\(\s*pipelineName\s*,\s*fromPhaseIndex/.test(fnBody),
    'inline resume must re-invoke runPipeline(pipelineName, fromPhaseIndex, ...)');
  // The tail (after the final SIGINT-off) must not contain an `if (...) return;`
  // guarding on an identifier that is never declared in the function scope.
  const tail = fnBody.slice(fnBody.lastIndexOf("process.off('SIGINT'"));
  assert.ok(!/if\s*\(\s*signalFired\s*\)/.test(tail),
    'no `if (signalFired)` guard may sit between signal teardown and the resume call');
});

if (_failed === 0) console.log('\nAll inline-resume regression tests passed.');
else { console.error(`\n${_failed} test(s) FAILED.`); process.exit(1); }
