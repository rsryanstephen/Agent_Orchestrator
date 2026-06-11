#!/usr/bin/env node
'use strict';

// Regression: every harness-built agent system prompt (planning/coding/assessment,
// including the coding-no-planning variant) must contain the OUTPUT FORMATTING
// MANDATE block, and the mandate must appear AFTER the caveman/prose-neutralisation
// block so bullet/spacing rules win on conflict.
//
// Why: planner mandates bullet formatting in its `Action:` directive, but the assessor
// and coder system prompts previously inherited only caveman ("fragments OK"), letting
// responses degrade into run-on paragraphs with missing post-period spacing.
//
// Run: node Agent_Orchestrator/tests/agent-output-formatting-mandate.test.js

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
    console.error(`  FAIL ${name}\n       ${e && (e.message || e)}`);
  }
}

test('outputFormattingMandateClause constant is defined', () => {
  assert.match(src, /const outputFormattingMandateClause\s*=/,
    'outputFormattingMandateClause must be declared in run-agent.js');
});

test('mandate text contains OUTPUT FORMATTING (MANDATORY) header', () => {
  assert.ok(
    src.includes('OUTPUT FORMATTING (MANDATORY'),
    'mandate must use the literal header "OUTPUT FORMATTING (MANDATORY"'
  );
});

test('mandate text contains ONE BLANK LINE rule', () => {
  assert.ok(
    src.includes('ONE BLANK LINE'),
    'mandate must require ONE BLANK LINE between bullets'
  );
});

test('mandate text contains space-after-punctuation rule', () => {
  assert.ok(
    src.includes('space after every full stop'),
    'mandate must require "space after every full stop, comma, colon, and semicolon"'
  );
});

test('mandate text contains backticks rule for code/paths', () => {
  assert.ok(
    /Code, file paths, and identifiers must be in `backticks`/.test(src),
    'mandate must require backticks for code/paths/identifiers'
  );
});

test('mandate text contains PRECEDENCE line over caveman', () => {
  assert.ok(
    src.includes('PRECEDENCE') && /Caveman compression applies WITHIN each bullet/.test(src),
    'mandate must contain explicit PRECEDENCE override stating caveman applies only within bullets'
  );
});

test('buildSystemPrompt appends outputFormattingMandateClause AFTER caveman/prose-neutralisation', () => {
  const fnMatch = src.match(/function buildSystemPrompt[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'buildSystemPrompt function body must be locatable');
  const body = fnMatch[0];
  const cavemanIdx = body.indexOf('cavemanClause || proseNeutralisationClause');
  const mandateIdx = body.indexOf('outputFormattingMandateClause');
  assert.ok(cavemanIdx >= 0, 'caveman injection line must exist in buildSystemPrompt');
  assert.ok(mandateIdx >= 0, 'mandate injection line must exist in buildSystemPrompt');
  assert.ok(
    mandateIdx > cavemanIdx,
    'outputFormattingMandateClause must be injected AFTER caveman/prose-neutralisation so formatting precedence wins'
  );
});

test('mandate is injected unconditionally (not role-guarded)', () => {
  // The append line must NOT be wrapped in `if (role === ...)` — every role gets it.
  const fnMatch = src.match(/function buildSystemPrompt[\s\S]*?\n\}/);
  assert.ok(fnMatch);
  const body = fnMatch[0];
  const lineMatch = body.match(/^[^\n]*outputFormattingMandateClause[^\n]*$/m);
  assert.ok(lineMatch, 'mandate injection line must be present');
  assert.ok(
    !/if\s*\([^)]*role\s*===/.test(lineMatch[0]),
    'mandate injection line must not be guarded by a role check (planning/coding/assessment all receive it)'
  );
});

test('VALIDATOR_SYSTEM (premise validator) intentionally exempt — verdict-only output', () => {
  const vsMatch = src.match(/const VALIDATOR_SYSTEM\s*=\s*'([^']+)'/);
  assert.ok(vsMatch, 'VALIDATOR_SYSTEM must exist');
  assert.ok(
    !/OUTPUT FORMATTING \(MANDATORY/.test(vsMatch[1]),
    'VALIDATOR_SYSTEM must NOT include bullet mandate — it emits SUBTASK_N: APPROVED/REJECTED lines'
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
