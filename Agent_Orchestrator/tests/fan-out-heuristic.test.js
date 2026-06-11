#!/usr/bin/env node
'use strict';

// Tests for intra-topic fan-out heuristics:
//  - splitPromptIntoTasks: numbered lists, bulleted lists, Agent N: prefixes
//  - parsePlanningSubtasks: ## Parallel Tasks override
//  - roleHeaderFor: (task-N) suffix generation for coding/assessment/fix
//  - max-parallel-agents-per-topic cap (excess tasks dropped) — source-level
//  - parallel-assessment-agents=false single-assessor path — source-level
//
// Functions under test live in src/lib/fan-out.js (extracted from run-agent.js).
// Source-level assertions still target run-agent.js for wiring checks.
//
// Run: node Agent_Orchestrator/tests/fan-out-heuristic.test.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');

// Pure functions now in the lib module — require directly (no eval needed).
const { splitPromptIntoTasks, parsePlanningSubtasks, roleHeaderFor, ROLE_HEADER } =
  require(path.join(HARNESS, 'src', 'lib', 'fan-out.js'));

// Source-level wiring checks still read run-agent.js.
const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e && e.stack || e}`);
  }
}

// ── splitPromptIntoTasks: numbered list ───────────────────────────────────────
test('splitPromptIntoTasks: numbered list → splits on 1. / 2. / 3.', () => {
  const content = '1. Fix bug in auth\n2. Add regression test\n3. Update docs';
  const tasks = splitPromptIntoTasks(content);
  assert.strictEqual(tasks.length, 3);
  assert.ok(tasks[0].includes('Fix bug in auth'));
  assert.ok(tasks[1].includes('Add regression test'));
  assert.ok(tasks[2].includes('Update docs'));
});

test('splitPromptIntoTasks: numbered list with preamble — preamble prepended to each task', () => {
  const content = 'Context: refactor module\n\n1. Extract helpers\n2. Add types';
  const tasks = splitPromptIntoTasks(content);
  assert.strictEqual(tasks.length, 2);
  assert.ok(tasks[0].includes('Context: refactor module'), 'preamble must be in task 0');
  assert.ok(tasks[1].includes('Context: refactor module'), 'preamble must be in task 1');
});

test('splitPromptIntoTasks: bulleted list (- items) → splits correctly', () => {
  const content = '- Add logging\n- Fix null ref\n- Write tests';
  const tasks = splitPromptIntoTasks(content);
  assert.strictEqual(tasks.length, 3);
  assert.ok(tasks[0].includes('Add logging'));
  assert.ok(tasks[2].includes('Write tests'));
});

test('splitPromptIntoTasks: bullet with asterisk (*) → splits', () => {
  const content = '* Task alpha\n* Task beta';
  const tasks = splitPromptIntoTasks(content);
  assert.strictEqual(tasks.length, 2);
});

test('splitPromptIntoTasks: Agent N: prefix wins over numbered list', () => {
  const content = 'Agent 1: Implement parser\n1. also here\nAgent 2: Write tests';
  const tasks = splitPromptIntoTasks(content);
  assert.strictEqual(tasks.length, 2, 'Agent N: anchors must win');
  assert.ok(tasks[0].includes('Implement parser'));
  assert.ok(tasks[1].includes('Write tests'));
});

test('splitPromptIntoTasks: single item → returns original content (no split)', () => {
  const content = '1. Single task only';
  const tasks = splitPromptIntoTasks(content);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0], content);
});

test('splitPromptIntoTasks: plain prose (no list anchors) → returns [content]', () => {
  const content = 'Just a plain prompt with no list structure at all.';
  const tasks = splitPromptIntoTasks(content);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0], content);
});

test('splitPromptIntoTasks: multi-line items accumulate body under anchor', () => {
  const content = '1. Do thing A\n   details for A\n2. Do thing B\n   details for B';
  const tasks = splitPromptIntoTasks(content);
  assert.strictEqual(tasks.length, 2);
  assert.ok(tasks[0].includes('details for A'), 'body lines must be in task 0');
  assert.ok(tasks[1].includes('details for B'), 'body lines must be in task 1');
});

// ── parsePlanningSubtasks: ## Parallel Tasks section ─────────────────────────
test('parsePlanningSubtasks: extracts tasks from ## Parallel Tasks section', () => {
  const planText = `## Implementation Plan\n\nSome plan text.\n\n## Parallel Tasks\n\n1. Implement parser\n2. Add regression tests\n\n## Risks\n\nNone.`;
  const tasks = parsePlanningSubtasks(planText);
  assert.ok(Array.isArray(tasks), 'must return array');
  assert.strictEqual(tasks.length, 2);
  assert.ok(tasks[0].includes('Implement parser'));
  assert.ok(tasks[1].includes('Add regression tests'));
});

test('parsePlanningSubtasks: no ## Parallel Tasks section → returns null', () => {
  const planText = `## Implementation Plan\n\n1. Step one\n2. Step two`;
  const result = parsePlanningSubtasks(planText);
  assert.strictEqual(result, null);
});

test('parsePlanningSubtasks: single item under ## Parallel Tasks → returns null (< 2 tasks)', () => {
  const planText = `## Parallel Tasks\n\n1. Only one task`;
  const result = parsePlanningSubtasks(planText);
  assert.strictEqual(result, null, 'single task must not trigger fan-out');
});

test('parsePlanningSubtasks: ## Parallel Tasks case-insensitive header match', () => {
  const planText = `## parallel tasks\n\n1. Task one\n2. Task two`;
  const tasks = parsePlanningSubtasks(planText);
  assert.ok(Array.isArray(tasks) && tasks.length === 2, 'case-insensitive header must match');
});

// ── roleHeaderFor: (task-N) suffix / parallel header format ──────────────────
// roleHeaderFor is imported from src/lib/fan-out.js — no eval needed.

test('roleHeaderFor: total=1 → returns base header (no numbering)', () => {
  assert.strictEqual(roleHeaderFor('coding', 1, 1), 'Coding Agent Response');
  assert.strictEqual(roleHeaderFor('assessment', 1, 1), 'Assessment Agent Response');
  assert.strictEqual(roleHeaderFor('planning', 1, 1), 'Planning Agent Response');
});

test('roleHeaderFor: total>1, coding → "Coding Agent N Response"', () => {
  assert.strictEqual(roleHeaderFor('coding', 1, 3), 'Coding Agent 1 Response');
  assert.strictEqual(roleHeaderFor('coding', 3, 3), 'Coding Agent 3 Response');
});

test('roleHeaderFor: total>1, assessment → "Assessment Agent N Response"', () => {
  assert.strictEqual(roleHeaderFor('assessment', 2, 4), 'Assessment Agent 2 Response');
});

test('roleHeaderFor: total>1, fix → "Coding Agent N Response (Remediation)"', () => {
  assert.strictEqual(roleHeaderFor('fix', 1, 2), 'Coding Agent 1 Response (Remediation)');
  assert.strictEqual(roleHeaderFor('fix', 2, 2), 'Coding Agent 2 Response (Remediation)');
});

// ── ANY_RESPONSE_HEADER regex: tolerates (task-N) legacy suffix ───────────────
test('ANY_RESPONSE_HEADER regex tolerates (task-N) legacy suffix in history', () => {
  // Source stores the string literal with escaped backslashes so the raw file
  // contains `task-\\d+` (two chars: backslash + d).
  assert.ok(
    src.includes('task-\\\\d+') || src.includes('task-\\d+') || src.includes('task-N'),
    'legacy (task-N) pattern must be referenced in run-agent.js (ANY_RESPONSE_HEADER or comment)'
  );
});

// ── max-parallel-agents-per-topic cap — excess tasks dropped ─────────────────
test('runCodingParallel: source caps tasks array at getMaxConcurrentAgents()', () => {
  // White-box: assert the slice pattern exists in source.
  assert.match(src, /subtasks\.slice\(0,\s*Math\.min\(subtasks\.length,\s*cap\)\)/,
    'runCodingParallel must slice subtasks to cap');
});

test('runAssessmentParallel: source caps tasks array at getMaxConcurrentAgents()', () => {
  assert.match(src, /runAssessmentParallel[\s\S]{0,200}subtasks\.slice\(0,\s*Math\.min/,
    'runAssessmentParallel must also slice to cap');
});

test('getMaxConcurrentAgents: falls back to max-concurrent-agents if per-topic key absent', () => {
  assert.match(src, /max-parallel-agents-per-topic.*\n.*max-concurrent-agents|max-concurrent-agents.*fallback|cfgRead.*max-concurrent-agents/,
    'fallback to legacy key must be present');
  // Confirm both key names appear in source.
  assert.ok(src.includes('max-parallel-agents-per-topic'), 'new key must be present');
  assert.ok(src.includes('max-concurrent-agents'), 'legacy fallback key must be present');
});

// ── parallel-assessment-agents=false: single assessor path ───────────────────
test('getParallelAssessmentAgents: defaults to false when key absent', () => {
  assert.match(src, /cfgRead\([^)]*'parallel-assessment-agents',\s*false\)/,
    "getParallelAssessmentAgents must default to false");
});

test('parallel-assessment-agents gate: run-agent branches on getParallelAssessmentAgents()', () => {
  // Confirm source consults getParallelAssessmentAgents before fan-out.
  assert.ok(src.includes('getParallelAssessmentAgents'), 'gating fn must exist in source');
  assert.match(src, /getParallelAssessmentAgents\s*\(\s*\)/,
    'gating fn must be called with no args (runtime reads config internally)');
});

// ── Heuristic split: indented lines are NOT treated as anchors ────────────────
test('splitPromptIntoTasks: indented numbered lines not treated as anchors', () => {
  // Top-level "1." splits; indented "  1." (continuation body) must NOT.
  const content = '1. Main task\n   1. Sub-step\n2. Second task';
  const tasks = splitPromptIntoTasks(content);
  // Only the top-level items are anchors — sub-steps accumulate into task[0].
  assert.strictEqual(tasks.length, 2, 'indented sub-steps must NOT create extra split');
  assert.ok(tasks[0].includes('Sub-step'), 'sub-step must fold into task 0 body');
});

// ── roleHeaderFor: planning role with total > 1 ───────────────────────────────
test('roleHeaderFor: total>1, planning → "Planning Agent N Response"', () => {
  assert.strictEqual(roleHeaderFor('planning', 1, 2), 'Planning Agent 1 Response');
  assert.strictEqual(roleHeaderFor('planning', 2, 2), 'Planning Agent 2 Response');
});

// ── splitPromptIntoTasks: empty / falsy content ───────────────────────────────
test('splitPromptIntoTasks: null input → returns [null]', () => {
  const tasks = splitPromptIntoTasks(null);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0], null);
});

test('splitPromptIntoTasks: empty string → returns [""]', () => {
  const tasks = splitPromptIntoTasks('');
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0], '');
});

// ── parsePlanningSubtasks: bulleted list inside ## Parallel Tasks ─────────────
test('parsePlanningSubtasks: bulleted list inside ## Parallel Tasks → extracts 2+ tasks', () => {
  const planText = `## Parallel Tasks\n\n- Implement parser\n- Add regression tests`;
  const tasks = parsePlanningSubtasks(planText);
  assert.ok(Array.isArray(tasks) && tasks.length === 2, 'bulleted Parallel Tasks must produce 2 tasks');
  assert.ok(tasks[0].includes('Implement parser'));
  assert.ok(tasks[1].includes('Add regression tests'));
});

// ── parsePlanningSubtasks: stops at next ## section ──────────────────────────
test('parsePlanningSubtasks: section body ends at next ## heading (does not bleed into next section)', () => {
  const planText = `## Parallel Tasks\n\n1. Task A\n2. Task B\n\n## Notes\n\n3. Not a task`;
  const tasks = parsePlanningSubtasks(planText);
  // tasks[1] must not include "Not a task" from the ## Notes section.
  assert.ok(Array.isArray(tasks) && tasks.length === 2, 'must extract exactly 2 tasks');
  assert.ok(!tasks[1].includes('Not a task'), 'tasks must not bleed past next ## section');
});

// ── fan-out.js import: run-agent.js must require the lib module ───────────────
test('run-agent.js requires ./lib/fan-out (splitPromptIntoTasks, parsePlanningSubtasks, roleHeaderFor)', () => {
  assert.ok(src.includes('lib/fan-out'), 'run-agent.js must require ./lib/fan-out');
  assert.ok(src.includes('splitPromptIntoTasks'), 'splitPromptIntoTasks must appear in run-agent.js (via require destructuring)');
  assert.ok(src.includes('parsePlanningSubtasks'), 'parsePlanningSubtasks must appear in run-agent.js (via require destructuring)');
  assert.ok(src.includes('roleHeaderFor'), 'roleHeaderFor must appear in run-agent.js (via require destructuring)');
});

// ── planningSubtasks fan-out: source wires into runCodingParallel ─────────────
test('run-agent wires plannedSubtasks → runCodingParallel in coding phase', () => {
  assert.ok(src.includes('plannedSubtasks'), 'plannedSubtasks var must exist');
  assert.ok(src.includes('runCodingParallel'), 'runCodingParallel must be called');
  // The planning phase sets plannedSubtasks after parsePlanningSubtasks.
  assert.match(src, /plannedSubtasks\s*=\s*subs/, 'planning phase must assign to plannedSubtasks');
});

test('resolveSubtasksFromPrompt: skips if getMaxConcurrentAgents() <= 1', () => {
  assert.match(src, /resolveSubtasksFromPrompt[\s\S]{0,100}getMaxConcurrentAgents\s*\(\s*\)\s*<=\s*1/,
    'heuristic prompt split must be gated behind cap > 1');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
