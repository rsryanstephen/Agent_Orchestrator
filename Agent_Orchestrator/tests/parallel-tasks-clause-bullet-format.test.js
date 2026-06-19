#!/usr/bin/env node
/**
 * Regression tests for the parallelPlanningClause / output-formatting-mandate
 * reconciliation.
 *
 * Root cause being guarded: the clause used to tell the planner to list each
 * subtask as a "numbered item", which conflicts with the output formatting
 * mandate (all top-level lines MUST be `- ` bullets, non-negotiable). Planners
 * resolved the conflict by dropping the `## Parallel Tasks` section into prose,
 * so the literal header vanished and parsePlanningSubtasks() found nothing to
 * fan out.
 *
 *  (1) parallelPlanningClause source contains the `## Parallel Tasks` header.
 *  (2) parallelPlanningClause instructs using a `- ` bullet per subtask.
 *  (3) parallelPlanningClause does NOT contain the words "numbered item".
 *  (4) parallelPlanningClause states the header is REQUIRED / not omittable.
 *  (5) parsePlanningSubtasks returns 2 tasks from a `## Parallel Tasks` block
 *      written as `- ` bullets (parser accepts bullet subtasks).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
const { parsePlanningSubtasks } = require(path.join(HARNESS, 'src', 'lib', 'fan-out.js'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { _failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

// NOTE (diagnostic H1 debt): the ideal here is to assert against
// buildSystemPrompt('planning'/'coding') output, but the require-export surface
// at run-agent.js:1650-1652 `return`s before `baseSystemPrompts`/clauses
// initialize, so calling the exported buildSystemPrompt throws. Until that shim
// is fixed (or a spawn-based payload-dump harness lands), cases (1)-(4),(7)
// remain source-grep. Tracked in test-conformance-audit.md.
function clauseSource() {
  const start = RUN_AGENT_SRC.indexOf('const parallelPlanningClause');
  assert.ok(start >= 0, 'parallelPlanningClause must be defined in run-agent.js');
  const end = RUN_AGENT_SRC.indexOf('const interrogateSkillPath', start);
  assert.ok(end > start, 'could not bound parallelPlanningClause source');
  return RUN_AGENT_SRC.slice(start, end);
}

test('(1) parallelPlanningClause references the `## Parallel Tasks` header', () => {
  assert.ok(clauseSource().includes('## Parallel Tasks'),
    'parallelPlanningClause must mention the literal "## Parallel Tasks" header');
});

test('(2) parallelPlanningClause instructs a `- ` bullet per subtask', () => {
  const src = clauseSource();
  assert.ok(/\\?`- \\?`?\s*bullet/i.test(src) || src.includes('`- ` bullet'),
    'parallelPlanningClause must instruct listing each subtask as a "`- ` bullet" item');
});

test('(3) parallelPlanningClause does NOT use the conflicting "numbered item" wording', () => {
  assert.ok(!/numbered item/i.test(clauseSource()),
    'parallelPlanningClause must NOT say "numbered item" — it conflicts with the bullet mandate');
});

test('(4) parallelPlanningClause makes the `## Parallel Tasks` header REQUIRED', () => {
  const src = clauseSource();
  assert.ok(/REQUIRED/i.test(src) && /header/i.test(src),
    'parallelPlanningClause must state the header is REQUIRED and may not be demoted into prose');
});

test('(5) parsePlanningSubtasks parses a bullet-formatted `## Parallel Tasks` block into 2 tasks', () => {
  const plan = [
    'Some plan preamble.',
    '',
    '## Parallel Tasks',
    '',
    '- Update `src/foo.js` to add the new handler and its unit test.',
    '',
    '- Update `src/bar.js` to wire the handler into the dispatcher.',
    '',
  ].join('\n');
  const tasks = parsePlanningSubtasks(plan);
  assert.ok(Array.isArray(tasks), 'parsePlanningSubtasks must return an array for a bullet block');
  assert.strictEqual(tasks.length, 2, `expected 2 tasks, got ${tasks ? tasks.length : 'null'}`);
  assert.ok(tasks[0].includes('foo.js') && tasks[1].includes('bar.js'),
    'each parsed task must retain its own bullet content');
});

test('(6) a multi-sentence subtask stays ONE task (no sentence-per-bullet fragmentation)', () => {
  // Guards the runtime tension flagged in QA: the output mandate says "one
  // sentence per bullet", but each top-level `- ` line under `## Parallel Tasks`
  // is parsed as a separate task. A subtask spanning 3 sentences kept on ONE
  // bullet must yield ONE task, not three.
  const plan = [
    '## Parallel Tasks',
    '',
    '- Update `src/foo.js` to add the handler. Add its unit test. Wire it into the dispatcher.',
    '',
    '- Update `src/bar.js` to register the new route.',
    '',
  ].join('\n');
  const tasks = parsePlanningSubtasks(plan);
  assert.ok(Array.isArray(tasks), 'parsePlanningSubtasks must return an array');
  assert.strictEqual(tasks.length, 2, `expected 2 tasks, got ${tasks ? tasks.length : 'null'}`);
  assert.ok(tasks[0].includes('handler') && tasks[0].includes('unit test') && tasks[0].includes('dispatcher'),
    'the multi-sentence subtask must remain a single task containing all three sentences');
});

test('(7) output formatting mandate exempts `## Parallel Tasks` from one-sentence-per-bullet', () => {
  const start = RUN_AGENT_SRC.indexOf('const outputFormattingMandateClause');
  assert.ok(start >= 0, 'outputFormattingMandateClause must be defined in run-agent.js');
  const end = RUN_AGENT_SRC.indexOf('function resolveStrictAssessmentClause', start);
  assert.ok(end > start, 'could not bound outputFormattingMandateClause source');
  const mandate = RUN_AGENT_SRC.slice(start, end);
  assert.ok(/EXCEPTION/.test(mandate) && /## Parallel Tasks/.test(mandate),
    'mandate must carve out `## Parallel Tasks` from the one-sentence-per-bullet rule');
});

if (_failed === 0) console.log('\nAll parallel-tasks-clause-bullet-format tests passed.');
else { console.error(`\n${_failed} test(s) FAILED.`); process.exit(1); }
