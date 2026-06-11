#!/usr/bin/env node
'use strict';

/**
 * Forensic-trace coverage for the dispatch-IIFE drain path.
 *
 * The sibling test `queue-drain-after-clarify-pause.test.js` confirms the
 * `finally`-gated dequeue + post-rerun re-check exist as source shape. This
 * file complements it by locking in the three load-bearing `appendAutoResumeLog`
 * trace lines that produce on-disk evidence of where the drain actually went on
 * a real `hrun`:
 *   (A) post-await runPipeline at the dispatch IIFE (both branches)
 *   (B) finally-gate decision (`pipelineResult` -> drain bool)
 *   (C) `dequeueAndTriggerNext` entry banner + each early-return branch
 *   (D) post-rerun fall-through inside runPipeline
 *
 * Note (architectural seam, intentionally not bypassed):
 *   A strict "spawn `node src/run-agent.js` with a stubbed pipeline" e2e was
 *   considered (see plan turn). `run-agent.js` runs its dispatch IIFE at
 *   require-time and never exports `runPipeline`/`dequeueAndTriggerNext` for
 *   injection. A true runtime test would either need a test-only export seam
 *   in `run-agent.js` or a `NODE_OPTIONS=--require <stub>` monkey-patch of the
 *   claude-CLI invocation site. Neither is in scope this turn — but the trace
 *   lines below mean a real `hrun` now writes irrefutable evidence to
 *   `Agent_Orchestrator/.state/auto-resume.log`, so the next reported "drain
 *   didn't fire" can be diagnosed from logs alone instead of by re-reading
 *   source.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── (A) post-await runPipeline trace, BOTH dispatch branches ─────────────────
test('dispatch IIFE logs `pipelineResult` typeof+value after every runPipeline await', () => {
  // continue branch
  assert.ok(
    /pipelineResult = await runPipeline\(state\.pipeline, state\.phaseIndex\);\s*\n\s*appendAutoResumeLog\(`dispatch: post-runPipeline \(continue\) pipelineResult typeof=\$\{typeof pipelineResult\} value=\$\{JSON\.stringify\(pipelineResult\)\}`\);/.test(src),
    'continue-branch post-await trace line is missing or malformed'
  );
  // roleArg branch
  assert.ok(
    /pipelineResult = await runPipeline\(roleArg, 0\);\s*\n\s*appendAutoResumeLog\(`dispatch: post-runPipeline \(roleArg="\$\{roleArg\}"\) pipelineResult typeof=\$\{typeof pipelineResult\} value=\$\{JSON\.stringify\(pipelineResult\)\}`\);/.test(src),
    'roleArg-branch post-await trace line is missing or malformed'
  );
});

// ── (B) finally-gate decision is logged BEFORE the drain call ────────────────
test('finally-gated dequeue logs `pipelineResult -> drain` decision', () => {
  const m = src.match(/let pipelineResult = false;[\s\S]*?\}\s*finally\s*\{([\s\S]*?)\}\s*\}\s*catch\s*\(err\)\s*\{[\s\S]*?restoreAutoModelFields\(\);/);
  assert.ok(m, 'must find dispatch IIFE finally block');
  const finallyBody = m[1];
  assert.ok(
    /const _drainGate = \(pipelineResult === true\);/.test(finallyBody),
    'finally must capture `_drainGate` so the same value is logged + used'
  );
  assert.ok(
    /appendAutoResumeLog\(`dispatch: dequeue-gate pipelineResult=\$\{JSON\.stringify\(pipelineResult\)\} -> drain=\$\{_drainGate\}`\);/.test(finallyBody),
    'finally must log the drain-gate decision'
  );
  // The gate guards the call.
  assert.ok(
    /if \(_drainGate\) await dequeueAndTriggerNext\(\);/.test(finallyBody),
    'finally must still call `dequeueAndTriggerNext` only when `_drainGate` is true'
  );
});

// ── (C) dequeueAndTriggerNext entry banner + early-return branch labels ──────
test('dequeueAndTriggerNext logs entry context (queueLen, td, autoAdvance, manualSubmit)', () => {
  const fnIdx = src.indexOf('async function dequeueAndTriggerNext(');
  assert.ok(fnIdx > 0, 'must find dequeueAndTriggerNext');
  const region = src.slice(fnIdx, fnIdx + 4000);
  assert.ok(
    /appendAutoResumeLog\(`dequeueAndTriggerNext: entry topic="\$\{topic\}" topicDir="\$\{td\}" queueLength=\$\{pending\} autoAdvance=\$\{autoAdvance\} manualSubmit=\$\{manualSubmit\}`\);/.test(region),
    'must log entry banner with topic/td/queueLength/autoAdvance/manualSubmit'
  );
});

test('every early-return inside dequeueAndTriggerNext labels its branch in the log', () => {
  const fnIdx = src.indexOf('async function dequeueAndTriggerNext(');
  const region = src.slice(fnIdx, fnIdx + 6000);
  // The four branches the plan calls out — empty, autoAdvance-off, all-held, unknown-shorthand.
  // Plus missing-or-empty-file (defensive, same shape).
  const branches = ['empty', 'autoAdvance-off', 'all-held', 'unknown-shorthand', 'missing-or-empty-file'];
  for (const b of branches) {
    const re = new RegExp(`dequeueAndTriggerNext: early-return branch=${b.replace(/[-]/g, '\\-')}`);
    assert.ok(re.test(region), `branch="${b}" must label its early-return log line`);
  }
});

// ── (D) post-rerun fall-through trace inside runPipeline ─────────────────────
test('runPipeline logs rerun-complete fall-through after the 2nd handleClarifyingQuestionsIfAny', () => {
  const rerunIdx = src.indexOf('isRerun: true });');
  assert.ok(rerunIdx > 0, 'must find rerun runPhase call');
  const region = src.slice(rerunIdx, rerunIdx + 600);
  assert.ok(
    /appendAutoResumeLog\(`runPipeline: clarifying-rerun complete phase="\$\{phaseName\}" phaseIndex=\$\{i\} -> falling through to post-loop return true`\);/.test(region),
    'must log rerun-complete fall-through trace right after the rerun runPhase await'
  );
});

if (failed === 0) console.log(`\nALL PASSED`);
else { console.error(`\n${failed} FAILED`); process.exitCode = 1; }
