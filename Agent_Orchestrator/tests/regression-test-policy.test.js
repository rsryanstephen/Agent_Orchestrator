#!/usr/bin/env node
'use strict';

// Regression tests for the three new regression-test policy rules in run-agent.js.
// Run: node Agent_Orchestrator/tests/regression-test-policy.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RUN_AGENT = path.join(__dirname, '..', 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Extract the regressionClause and regressionAssessmentClause string literals
// from the source so we can verify true/false branches without spawning a child.
function extractClauseLiteral(varName) {
  const re = new RegExp(`const ${varName} = topicConfig\\.regressionTests[\\s\\S]*?:\\s*'';`);
  const m = src.match(re);
  assert.ok(m, `${varName} block not found`);
  return m[0];
}
const regressionClauseBlock = extractClauseLiteral('regressionClause');
const regressionAssessmentClauseBlock = extractClauseLiteral('regressionAssessmentClause');

// ── Rule 1: requirement-comment mandate ──────────────────────────────────────
// Requirement: "each new/modified regression test or test group MUST be preceded
// by a comment block quoting the verbatim requirement bullet it covers"
test('regressionClause includes requirement-comment mandate when regression-tests=true', () => {
  assert.ok(/REQUIREMENT-COMMENT MANDATE/.test(regressionClauseBlock),
    'mandate header missing from regressionClause');
  assert.ok(/verbatim requirement bullet/.test(regressionClauseBlock),
    'verbatim-bullet wording missing');
});

// Requirement: "each new/modified regression test or test group MUST be preceded
// by a comment block quoting the verbatim requirement bullet it covers"
test('regressionClause empty when regression-tests=false (mandate absent)', () => {
  assert.ok(/:\s*''/.test(regressionClauseBlock), 'false-branch must be empty string');
  // The false-branch substring (empty) means the mandate text only appears once
  // in the block — inside the true-branch literal.
  const occurrences = (regressionClauseBlock.match(/REQUIREMENT-COMMENT MANDATE/g) || []).length;
  assert.strictEqual(occurrences, 1, 'mandate must only appear in true-branch');
});

// ── Rule 2: immutability ─────────────────────────────────────────────────────
// Requirement: "do NOT modify existing regression tests if the change would
// imply a change to the requirement comment above them"
test('regressionClause includes immutability rule', () => {
  assert.ok(/IMMUTABILITY/.test(regressionClauseBlock), 'IMMUTABILITY header missing');
  assert.ok(/do NOT modify existing regression tests/i.test(regressionClauseBlock),
    'immutability wording missing');
});

// ── Rule 3: conflict handling via clarifying questions ───────────────────────
// Requirement: "if a new prompt requirement conflicts with an existing
// documented requirement above a test, STOP and emit `## Clarifying Questions`
// to confirm before touching the test; on confirmation, update both the test
// and its requirement comment in lockstep"
test('regressionClause includes conflict-handling rule referencing ## Clarifying Questions header', () => {
  assert.ok(/CONFLICT HANDLING/.test(regressionClauseBlock), 'CONFLICT HANDLING header missing');
  assert.ok(/## Clarifying Questions/.test(regressionClauseBlock),
    'verbatim ## Clarifying Questions header must be referenced so harness pause-detection still works');
  assert.ok(/lockstep/i.test(regressionClauseBlock), 'lockstep update requirement missing');
});

// ── Assessment-side audit clauses ────────────────────────────────────────────
// Requirement: assessment agent must flag missing requirement-comments as BLOCKER
test('regressionAssessmentClause audits missing requirement-comments as BLOCKER', () => {
  assert.ok(/AUDIT — REQUIREMENT-COMMENT MANDATE/.test(regressionAssessmentClauseBlock),
    'audit header for requirement-comment missing');
  assert.ok(/BLOCKER/.test(regressionAssessmentClauseBlock), 'BLOCKER keyword missing');
});

// Requirement: assessment agent must flag silent requirement-implying edits as BLOCKER
test('regressionAssessmentClause audits immutability violations as BLOCKER', () => {
  assert.ok(/AUDIT — IMMUTABILITY/.test(regressionAssessmentClauseBlock),
    'audit header for immutability missing');
  assert.ok(/in lockstep/i.test(regressionAssessmentClauseBlock),
    'lockstep audit wording missing');
});

// Requirement: assessment agent must flag silent deletion of documented tests as BLOCKER
test('regressionAssessmentClause audits silent deletion as BLOCKER', () => {
  assert.ok(/AUDIT — SILENT DELETION/.test(regressionAssessmentClauseBlock),
    'audit header for silent deletion missing');
  assert.ok(/Clarifying Questions/.test(regressionAssessmentClauseBlock),
    'silent-deletion audit must reference ## Clarifying Questions exchange');
});

// ── Both clauses must collapse to empty string when regression-tests=false ──
// Requirement: new clauses are gated on regression-tests=true (only appended
// when the flag is on; absent otherwise)
test('both clauses are gated on regression-tests=true (empty false-branch)', () => {
  for (const block of [regressionClauseBlock, regressionAssessmentClauseBlock]) {
    assert.ok(/:\s*''\s*;/.test(block), 'false-branch must be empty string literal');
  }
});
