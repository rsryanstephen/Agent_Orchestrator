#!/usr/bin/env node
'use strict';

// Tests for the parallel premise-validator stage wired into runPlanning().
//
// Checks:
//  - validate-parallel-premises=false (default) → validator never called
//  - validate-parallel-premises=true  → validator called; rejections drop subtasks
//  - All subtasks approved             → none dropped
//  - Validator throws                  → falls back to all subtasks (safe path)
//  - Partial rejections                → only failing subtasks removed
//
// Run: node Agent_Orchestrator/tests/parallel-premise-validator.test.js

const path = require('path');
const fs   = require('fs');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
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

// ── Source-level wiring checks ─────────────────────────────────────────────────

test('validate-parallel-premises config key read via cfgRead', () => {
  assert.ok(
    src.includes("cfgRead(topicConfig, config, 'validate-parallel-premises'"),
    'must read validate-parallel-premises via cfgRead'
  );
});

test('validateParallelPremises async function defined', () => {
  assert.ok(
    /async function validateParallelPremises\s*\(/.test(src),
    'validateParallelPremises must be defined as async function'
  );
});

test('validator invoked only when config flag true', () => {
  const callSite = src.match(/cfgRead\(topicConfig, config, 'validate-parallel-premises'[^)]*\)[^{]*\{[\s\S]{0,200}validateParallelPremises/);
  assert.ok(callSite, 'validateParallelPremises must be called inside cfgRead guard');
});

test('rejected subtasks are not pushed to approved', () => {
  assert.ok(
    /REJECTED/i.test(src) && /approved\.push/.test(src),
    'approved array must exclude REJECTED subtasks'
  );
});

test('validator error falls back to all subtasks', () => {
  assert.ok(
    /catch\s*\(err\)[\s\S]{0,200}return subtasks/.test(src),
    'catch block must return original subtasks on validator error'
  );
});

test('approved count logged after validation', () => {
  assert.ok(
    /Premise validator approved/.test(src),
    'must log approved count after validation'
  );
});

test('rejected reason logged per subtask', () => {
  assert.ok(
    /Premise validator rejected subtask/.test(src),
    'must log rejection reason per subtask'
  );
});

test('validator uses minimal system prompt (not systemPrompts.planning)', () => {
  const fnMatch = src.match(/async function validateParallelPremises[\s\S]*?^\}/m);
  assert.ok(fnMatch, 'validateParallelPremises function must exist');
  assert.ok(
    !fnMatch[0].includes('systemPrompts.planning'),
    'validator must not use systemPrompts.planning — it injects parallelPlanningClause which emits ## Parallel Tasks instead of APPROVED/REJECTED'
  );
});

// ── Unit: APPROVED/REJECTED parsing logic (extracted inline) ──────────────────

function parseValidatorOutput(validatorText, subtasks) {
  const approved = [];
  subtasks.forEach((task, i) => {
    const n = i + 1;
    const lineRe = new RegExp(`SUBTASK_${n}:\\s*(APPROVED|REJECTED)`, 'i');
    const m = validatorText.match(lineRe);
    if (!m || /APPROVED/i.test(m[1])) {
      approved.push(task);
    }
  });
  return approved;
}

test('all approved → all subtasks kept', () => {
  const tasks = ['fix auth', 'add tests', 'update docs'];
  const out = 'SUBTASK_1: APPROVED\nSUBTASK_2: APPROVED\nSUBTASK_3: APPROVED';
  assert.deepStrictEqual(parseValidatorOutput(out, tasks), tasks);
});

test('one rejected → that subtask removed', () => {
  const tasks = ['fix auth', 'add tests', 'update docs'];
  const out = 'SUBTASK_1: APPROVED\nSUBTASK_2: REJECTED — premise not found\nSUBTASK_3: APPROVED';
  const result = parseValidatorOutput(out, tasks);
  assert.strictEqual(result.length, 2);
  assert.ok(!result.includes('add tests'));
});

test('all rejected → empty approved list', () => {
  const tasks = ['fix auth', 'add tests'];
  const out = 'SUBTASK_1: REJECTED — wrong file\nSUBTASK_2: REJECTED — fn missing';
  const result = parseValidatorOutput(out, tasks);
  assert.strictEqual(result.length, 0);
});

test('missing SUBTASK line → subtask kept (safe default)', () => {
  const tasks = ['fix auth', 'add tests'];
  const out = 'SUBTASK_1: APPROVED'; // SUBTASK_2 missing
  const result = parseValidatorOutput(out, tasks);
  assert.strictEqual(result.length, 2, 'missing verdict → keep subtask');
});

test('case-insensitive APPROVED match', () => {
  const tasks = ['fix auth'];
  const out = 'SUBTASK_1: approved';
  const result = parseValidatorOutput(out, tasks);
  assert.strictEqual(result.length, 1);
});

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
