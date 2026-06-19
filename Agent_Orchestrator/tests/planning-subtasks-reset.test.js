#!/usr/bin/env node
'use strict';

// Regression test for the `plannedSubtasks` state-leak bug. The module-level
// `let plannedSubtasks` in `run-agent.js` was only ASSIGNED inside `runPlanning`
// when the current plan contained `## Parallel Tasks` — never reset. A second
// pipeline iteration whose plan lacked the section would inherit the prior
// round's subtasks and fan out coding agents against stale, no-longer-relevant
// tasks (see topic_files/claude_harness/Plnning agent rejected.md).
//
// `runPlanning` is not exported (run-agent.js short-circuits in non-main mode),
// so we cannot drive it directly. Instead this test asserts the BEHAVIORAL
// guard the fix relies on — `parsePlanningSubtasks` returns `null` when the
// plan text lacks a `## Parallel Tasks` section — AND verifies the two reset
// sites exist in run-agent.js by requiring the source and confirming the
// reset assignment appears at the top of both `runPlanning` and `runPipeline`.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const { parsePlanningSubtasks, nextPlannedSubtasksFromPlan } = require(path.join(HARNESS, 'src', 'lib', 'fan-out.js'));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('parsePlanningSubtasks returns null when plan lacks ## Parallel Tasks', () => {
  const planWithoutSection = [
    '## Plan',
    '- Step 1: read file X',
    '- Step 2: edit function Y',
    '- Step 3: verify with test Z',
  ].join('\n');
  assert.strictEqual(
    parsePlanningSubtasks(planWithoutSection),
    null,
    'plan with no `## Parallel Tasks` heading must yield null — this is the precondition the reset fix relies on'
  );
});

test('parsePlanningSubtasks returns subtasks when ## Parallel Tasks present with multiple items', () => {
  const planWithSection = [
    '## Plan',
    '- Overview text',
    '',
    '## Parallel Tasks',
    '1. Fix bug A in module M',
    '2. Refactor helper B in module N',
    '',
    '## Notes',
    'misc',
  ].join('\n');
  const subs = parsePlanningSubtasks(planWithSection);
  assert.ok(Array.isArray(subs), 'expected an array when section is present with >=2 items');
  assert.strictEqual(subs.length, 2, `expected 2 subtasks; got ${subs && subs.length}`);
});

function headOfFn(src, fnDecl, sliceLen) {
  const idx = src.indexOf(fnDecl);
  assert.ok(idx >= 0, `could not locate "${fnDecl}" in run-agent.js`);
  return src.slice(idx, idx + sliceLen);
}

// Behavioral round-leak test — replaces the source-grep fallback. Simulates two
// consecutive planning rounds against the pure reducer: round 1 emits a plan
// WITH `## Parallel Tasks`, round 2 emits a plan WITHOUT it. The contract is
// that round 2's return value alone determines the next state, so it must be
// null regardless of round 1's value. This is exactly the bug the original
// `if (subs) plannedSubtasks = subs` guard caused, and this test catches any
// reintroduction (rename of the variable, refactor of the helper) by asserting
// the reducer contract rather than grepping source.
test('nextPlannedSubtasksFromPlan: round-2 plan without ## Parallel Tasks yields null (no leak from round 1)', () => {
  const round1 = [
    '## Plan',
    '',
    '## Parallel Tasks',
    '1. Fix bug A',
    '2. Refactor helper B',
  ].join('\n');
  const round2 = [
    '## Plan',
    '- Single-track follow-up: tweak config Y',
  ].join('\n');
  let state = nextPlannedSubtasksFromPlan(round1);
  assert.ok(Array.isArray(state) && state.length === 2, 'round 1 must produce 2 subtasks');
  state = nextPlannedSubtasksFromPlan(round2);
  assert.strictEqual(state, null, 'round 2 reducer return must be null — prior-round value cannot leak');
});

test('nextPlannedSubtasksFromPlan: degenerate single-item parallel section yields null', () => {
  const planSingle = ['## Parallel Tasks', '1. Only one task'].join('\n');
  assert.strictEqual(nextPlannedSubtasksFromPlan(planSingle), null, 'single-item parallel section is not parallelisable');
});

test('nextPlannedSubtasksFromPlan: empty / null input yields null', () => {
  assert.strictEqual(nextPlannedSubtasksFromPlan(''), null);
  assert.strictEqual(nextPlannedSubtasksFromPlan(null), null);
  assert.strictEqual(nextPlannedSubtasksFromPlan(undefined), null);
});

test('run-agent.js resets plannedSubtasks at top of runPlanning', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  const head = headOfFn(src, 'async function runPlanning', 1200);
  assert.ok(
    /plannedSubtasks\s*=\s*null/.test(head),
    'runPlanning must reset `plannedSubtasks = null` near the top so prior-round subtasks cannot leak'
  );
});

test('run-agent.js resets plannedSubtasks at top of runPipeline', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  const head = headOfFn(src, 'async function runPipeline', 1600);
  assert.ok(
    /plannedSubtasks\s*=\s*null/.test(head),
    'runPipeline must reset `plannedSubtasks = null` near the top to defend against resume paths that skip planning'
  );
});

if (failed === 0) console.log(`\nALL PASSED`);
else { console.error(`\n${failed} FAILED`); process.exitCode = 1; }
