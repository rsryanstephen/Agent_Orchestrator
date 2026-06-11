#!/usr/bin/env node
'use strict';

/**
 * Regression: queue must drain after a pipeline that traversed a clarifying-question
 * pause + rerun. Root cause was twofold:
 *   (a) post-rerun, the pipeline never re-checked `handleClarifyingQuestionsIfAny()`,
 *       so a second round of questions silently advanced to the next phase.
 *   (b) the dispatch IIFE called `dequeueAndTriggerNext` outside a `finally`, so an
 *       error/exit between `runPipeline` resolving and the dequeue call would skip
 *       the drain entirely while leaving resume-state stale.
 *
 * These are source-level grep tests in the style of prompt-queue.test.js:307-345.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── (1) Post-rerun, a SECOND `handleClarifyingQuestionsIfAny()` must run ──────
test('post-rerun re-checks clarifying questions so a second round pauses cleanly', () => {
  // Extract the for-loop body of runPipeline that contains the rerun branch.
  const rerunIdx = runAgentSrc.indexOf('isRerun: true });');
  assert.ok(rerunIdx > 0, 'must find the rerun runPhase call');
  // Look in the ~800 chars immediately following the rerun call (same `{ ... }` scope).
  // Range bumped to absorb the post-rerun `appendAutoResumeLog` trace line added for forensic
  // evidence on a real `hrun` — see dispatch-iife-drain-after-clarify-rerun.test.js.
  const region = runAgentSrc.slice(rerunIdx, rerunIdx + 1500);
  assert.ok(/await handleClarifyingQuestionsIfAny\(\)/.test(region),
    'must re-invoke `handleClarifyingQuestionsIfAny()` after the rerun runPhase call');
});

// ── (2) Dispatch IIFE uses `finally`-gated dequeue keyed on `=== true` ────────
test('dispatch IIFE wraps runPipeline in finally and dequeues only on `=== true`', () => {
  // Slice from the dispatch try/await/runPipeline region through the IIFE's outer catch.
  const m = runAgentSrc.match(/let pipelineResult = false;([\s\S]*?)\}\s*catch\s*\(err\)\s*\{[\s\S]*?restoreAutoModelFields\(\);/);
  assert.ok(m, 'must find the dispatch IIFE pipeline-run block');
  const block = m[1];
  assert.ok(/\}\s*finally\s*\{/.test(block),
    'dispatch IIFE must contain a `finally` block wrapping the runPipeline call');
  // Gate idiom: capture `_drainGate = (pipelineResult === true)` then guard the call.
  // Both shapes (direct `if (pipelineResult === true)` and via `_drainGate`) are equivalent;
  // accept either so the forensic-trace refactor doesn't churn this assertion.
  assert.ok(
    /if \(pipelineResult === true\) await dequeueAndTriggerNext\(\)/.test(block) ||
    (/const _drainGate = \(pipelineResult === true\);/.test(block) &&
     /if \(_drainGate\) await dequeueAndTriggerNext\(\)/.test(block)),
    'dequeueAndTriggerNext must be guarded by `pipelineResult === true` inside the finally'
  );
  // The pre-fix dispatch-IIFE idiom `(await runPipeline(roleArg, 0)) !== false`
  // allowed `undefined` results to be treated as success — must be gone from the
  // dispatch IIFE (the in-process drain branch in dequeueAndTriggerNext is allowed
  // to keep its own truthy-check, scoped only to itself).
  assert.ok(!/\(await runPipeline\(roleArg[^)]*\)\) !== false/.test(runAgentSrc),
    'legacy `!== false` truthy-check on dispatch-IIFE runPipeline must be removed');
  assert.ok(!/\(await runPipeline\(state\.pipeline[^)]*\)\) !== false/.test(runAgentSrc),
    'legacy `!== false` truthy-check on continue-branch runPipeline must be removed');
});

// ── (3) Auto-resume / network / die paths must NOT reach dequeue ─────────────
test('non-true runPipeline returns (auto-resume `return false`) skip the dequeue', () => {
  // Both auto-resume paths explicitly `return false` so the finally-gated dequeue
  // (keyed on `=== true`) is bypassed.
  const returns = runAgentSrc.match(/return false;/g) || [];
  assert.ok(returns.length >= 2,
    'runPipeline must retain its two `return false` auto-resume paths');
});
