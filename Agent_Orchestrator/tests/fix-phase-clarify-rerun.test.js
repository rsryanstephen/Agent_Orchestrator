#!/usr/bin/env node
'use strict';

/**
 * Verifies that the 'fix' (remediation) phase is included in the
 * clarifying-question re-run guard inside runPipeline, and that
 * assessment is re-run after a fix re-run when the pipeline included it.
 *
 * Prior bug: the guard was `phaseName === 'planning' || phaseName === 'coding'`,
 * which excluded 'fix'. When the remediation coding agent emitted
 * ## Clarifying Questions and an auto-reply was captured, nothing re-ran —
 * the harness silently dropped the work and moved to the next queue item.
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

// ── 1. Guard condition includes 'fix' ────────────────────────────────────────
test("clarifying-rerun guard includes 'fix' alongside 'planning' and 'coding'", () => {
  // The condition must contain all three phase names.
  const m = src.match(/if\s*\(paused\s*&&\s*\([^)]*phaseName\s*===\s*'planning'[^)]*phaseName\s*===\s*'coding'[^)]*phaseName\s*===\s*'fix'[^)]*\)\s*\)/);
  assert.ok(
    m,
    "runPipeline clarifying-rerun guard must be `paused && (phaseName === 'planning' || phaseName === 'coding' || phaseName === 'fix')`"
  );
});

// ── 2. Post-fix assessment block exists and is gated correctly ───────────────
test("after fix re-run, assessment runs only when pipeline includes 'assessment'", () => {
  // Find the rerun runPhase call then check the assessment-injection that follows.
  const rerunIdx = src.indexOf("isRerun: true });");
  assert.ok(rerunIdx > 0, "must find rerun runPhase call with isRerun: true");
  // Look in a window large enough to cover both the 2nd handleClarifyingQuestionsIfAny
  // and the new post-fix assessment block.
  const region = src.slice(rerunIdx, rerunIdx + 1800);
  assert.ok(
    /phaseName === 'fix' && phases\.includes\('assessment'\)/.test(region),
    "post-fix assessment must be gated on `phaseName === 'fix' && phases.includes('assessment')`"
  );
  assert.ok(
    /runPhase\('assessment',/.test(region),
    "post-fix assessment step must call runPhase('assessment', ...)"
  );
  assert.ok(
    /isFinal:\s*true/.test(region),
    "post-fix assessment must be called with isFinal: true (it is the final step)"
  );
});

// ── 3. Planning and coding still covered (no regression) ─────────────────────
test("'planning' and 'coding' remain in the clarifying-rerun guard (no regression)", () => {
  const idx = src.indexOf("phaseName === 'planning' || phaseName === 'coding' || phaseName === 'fix'");
  assert.ok(idx > 0, "'planning' and 'coding' must still be in the guard alongside 'fix'");
});

if (failed === 0) console.log('\nALL PASSED');
else { console.error(`\n${failed} FAILED`); process.exitCode = 1; }
