#!/usr/bin/env node
'use strict';

// Tests that the planning system prompt contains the Premise Burden of Proof
// clauses added to parallelPlanningClause, and that the planning role's
// Strict Assessment Mode is a planner self-audit variant (not the generic
// assessment-role text).
//
// Run: node Agent_Orchestrator/tests/planning-premise-evidence.test.js

const path = require('path');
const fs = require('fs');
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

// ── parallelPlanningClause: Premise Burden of Proof subsection ────────────────
test('parallelPlanningClause contains "Premise Burden of Proof" heading', () => {
  assert.ok(
    src.includes('Premise Burden of Proof'),
    'parallelPlanningClause must include a "Premise Burden of Proof" subsection'
  );
});

test('parallelPlanningClause requires file:line evidence citation', () => {
  assert.ok(
    src.includes('file:line') || src.includes('file:\\\\:line') || /`file:line`/.test(src),
    'parallelPlanningClause must require explicit file:line evidence citation'
  );
});

test('parallelPlanningClause requires grep/test that fails if bug absent', () => {
  assert.ok(
    /grep pattern or test name.*FAIL|FAIL.*if the bug were absent|would FAIL if the bug were absent/i.test(src),
    'parallelPlanningClause must require a grep pattern or test name that would fail if bug absent'
  );
});

test('parallelPlanningClause mandates removing unverified diagnoses from plan', () => {
  assert.ok(
    /premise is false.*remove|remove.*root cause|not delegated|MUST NOT be delegated/i.test(src),
    'parallelPlanningClause must state unverified root causes must not be delegated'
  );
});

test('parallelPlanningClause Burden of Proof is gated on getMaxConcurrentAgents() > 1', () => {
  // The Premise Burden of Proof text lives inside the parallelPlanningClause ternary,
  // which is only truthy when getMaxConcurrentAgents() > 1.
  const clauseMatch = src.match(/const parallelPlanningClause[\s\S]*?^  : '';/m);
  assert.ok(clauseMatch, 'parallelPlanningClause declaration must be present');
  assert.ok(
    clauseMatch[0].includes('Premise Burden of Proof'),
    'Premise Burden of Proof must be inside the parallelPlanningClause ternary (gated on concurrent agents)'
  );
});

// ── planningStrictAssessmentClause: planner self-audit variant ────────────────
test('resolveStrictAssessmentClause accepts a role parameter', () => {
  assert.match(src, /function resolveStrictAssessmentClause\s*\(\s*role\s*\)/,
    'resolveStrictAssessmentClause must accept a role parameter');
});

test('planningStrictAssessmentClause variable is declared', () => {
  assert.ok(
    src.includes('planningStrictAssessmentClause'),
    'planningStrictAssessmentClause variable must be declared'
  );
});

test('planningStrictAssessmentClause uses "planner self-audit" header', () => {
  assert.ok(
    src.includes('planner self-audit'),
    'planning strict assessment clause must use "planner self-audit" in its header'
  );
});

test('planningStrictAssessmentClause text references planner verifying own diagnosis', () => {
  assert.ok(
    /your own diagnosis|YOUR OWN diagnosis|root-cause analysis is WRONG/i.test(src),
    'planning strict assessment must tell planner to verify its own diagnosis before delegating'
  );
});

test('buildSystemPrompt uses planningStrictAssessmentClause for planning role', () => {
  assert.match(src, /role === 'planning'\s*\)\s*prompt \+= planningStrictAssessmentClause/,
    'buildSystemPrompt must add planningStrictAssessmentClause (not strictAssessmentClause) for planning role');
});

test('buildSystemPrompt still uses strictAssessmentClause for coding+noPlanning role', () => {
  assert.match(src, /codingNoPlanning.*prompt \+= strictAssessmentClause|role === 'coding'.*codingNoPlanning.*strictAssessmentClause/s,
    'buildSystemPrompt must still use strictAssessmentClause for coding+noPlanning role');
});

// ── Source wiring: resolveStrictAssessmentClause called for both roles ─────────
test('strictAssessmentClause assigned from resolveStrictAssessmentClause() with no args', () => {
  assert.match(src, /const strictAssessmentClause = resolveStrictAssessmentClause\(\s*\)/,
    'strictAssessmentClause must be assigned via resolveStrictAssessmentClause() with no args');
});

test('planningStrictAssessmentClause assigned from resolveStrictAssessmentClause("planning")', () => {
  assert.match(src, /const planningStrictAssessmentClause = resolveStrictAssessmentClause\s*\(\s*'planning'\s*\)/,
    'planningStrictAssessmentClause must be assigned via resolveStrictAssessmentClause("planning")');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
