#!/usr/bin/env node
'use strict';

// Integration-level checks for buildSystemPrompt role routing and
// validateParallelPremises validator system prompt.
//
// These go beyond wording assertions — they verify that the CORRECT clauses are
// present in the CORRECT roles and that disallowed clauses are absent where expected.
//
// Run: node Agent_Orchestrator/tests/build-system-prompt.test.js

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

// ── buildSystemPrompt role routing ────────────────────────────────────────────

test('planning role: planningStrictAssessmentClause applied (not generic strictAssessmentClause)', () => {
  // In buildSystemPrompt, the planning branch must use planningStrictAssessmentClause.
  assert.match(src, /role === 'planning'\s*\)\s*prompt \+= planningStrictAssessmentClause/,
    'planning role must use planningStrictAssessmentClause');
});

test('coding+noPlanning role: strictAssessmentClause applied (not planningStrictAssessmentClause)', () => {
  assert.match(src, /codingNoPlanning\s*\)\s*prompt \+= strictAssessmentClause|role === 'coding'[^\n]*codingNoPlanning[^\n]*strictAssessmentClause/s,
    'coding+noPlanning must use strictAssessmentClause (generic, not planning variant)');
});

test('planning role: parallelPlanningClause applied', () => {
  assert.match(src, /role === 'planning'\s*\)\s*prompt \+= parallelPlanningClause/,
    'planning role must include parallelPlanningClause');
});

test('planning role header is "planner self-audit" (not generic)', () => {
  assert.ok(
    src.includes('planner self-audit — mandatory'),
    'planning strict assessment header must say "planner self-audit — mandatory"'
  );
});

test('coding role header is generic "mandatory" (not planning variant)', () => {
  assert.ok(
    src.includes('## Strict Assessment Mode (mandatory)'),
    'coding strict assessment header must be ## Strict Assessment Mode (mandatory)'
  );
  assert.ok(
    !src.includes('## Strict Assessment Mode (planning — mandatory)'),
    'old (planning — mandatory) header must not appear (was renamed)'
  );
});

test('assessment role: no parallelPlanningClause injected', () => {
  // parallelPlanningClause is only added when role === 'planning'.
  // Verify the condition is tightly scoped.
  const planningClauseBlock = src.match(/if\s*\(role === 'planning'\s*\)\s*prompt \+= parallelPlanningClause/);
  assert.ok(planningClauseBlock, 'parallelPlanningClause injection must be guarded by role === planning');
});

// ── validateParallelPremises: minimal system prompt ───────────────────────────

test('validateParallelPremises does NOT use systemPrompts.planning', () => {
  // Extract the validateParallelPremises function body.
  const fnMatch = src.match(/async function validateParallelPremises[\s\S]*?^\}/m);
  assert.ok(fnMatch, 'validateParallelPremises function must exist');
  assert.ok(
    !fnMatch[0].includes('systemPrompts.planning'),
    'validateParallelPremises must not use systemPrompts.planning (would inject parallelPlanningClause -> pollutes verdicts)'
  );
});

test('validateParallelPremises defines its own minimal VALIDATOR_SYSTEM prompt', () => {
  assert.ok(
    src.includes('VALIDATOR_SYSTEM'),
    'validateParallelPremises must define VALIDATOR_SYSTEM for its own minimal system prompt'
  );
});

test('VALIDATOR_SYSTEM contains verdict-only instruction', () => {
  const vsMatch = src.match(/const VALIDATOR_SYSTEM\s*=\s*'([^']+)'/);
  assert.ok(vsMatch, 'VALIDATOR_SYSTEM must be a string literal');
  assert.ok(
    /SUBTASK_N.*APPROVED.*REJECTED/i.test(vsMatch[1]) || /APPROVED.*REJECTED/i.test(vsMatch[1]),
    'VALIDATOR_SYSTEM must reference APPROVED/REJECTED verdict format'
  );
  assert.ok(
    /nothing else|Output nothing/i.test(vsMatch[1]),
    'VALIDATOR_SYSTEM must instruct to output nothing else'
  );
});

// ── Premise Rejected detection in runCodingParallel ──────────────────────────

test('runCodingParallel warns to stderr when ## Premise Rejected detected', () => {
  assert.ok(
    src.includes('Premise Rejected') && src.includes('process.stderr.write'),
    'runCodingParallel must write a stderr warning when ## Premise Rejected found in agent output'
  );
});

test('Premise Rejected warning identifies the agent number', () => {
  const warnMatch = src.match(/process\.stderr\.write\([^)]*Premise Rejected[^)]*\)/);
  assert.ok(warnMatch, 'stderr.write for Premise Rejected must exist');
  assert.ok(
    /Coding Agent.*\$\{i \+ 1\}/.test(warnMatch[0]) || warnMatch[0].includes('i + 1'),
    'warning must identify the agent index'
  );
});

test('Premise Rejected regex test is anchored to ## heading', () => {
  assert.match(src, /\/\^##\\s\+Premise Rejected\/im/,
    'Premise Rejected regex must be anchored with ^ to avoid matching inside prose');
});

// ── Config guard and attribution clauses ─────────────────────────────────────

test('coding prompt contains codingConfigGuardClause (MUST NOT modify + global-config.json)', () => {
  assert.match(src, /codingConfigGuardClause/,
    'codingConfigGuardClause variable must be defined in run-agent.js');
  assert.ok(
    src.includes('MUST NOT modify') && src.includes('global-config.json'),
    'codingConfigGuardClause must reference "MUST NOT modify" and "global-config.json"'
  );
  assert.match(src, /role === 'coding'\s*\)\s*prompt \+= codingConfigGuardClause/,
    'buildSystemPrompt must inject codingConfigGuardClause for role === coding');
});

test('assessment prompt contains assessmentConfigAttributionClause (Do NOT attribute config diffs)', () => {
  assert.match(src, /assessmentConfigAttributionClause/,
    'assessmentConfigAttributionClause variable must be defined in run-agent.js');
  assert.ok(
    src.includes('Do NOT attribute config diffs') || src.includes('Do NOT attribute'),
    'assessmentConfigAttributionClause must instruct not to attribute config diffs to coding agent'
  );
  assert.match(src, /role === 'assessment'[^\n]*assessmentConfigAttributionClause|assessmentConfigAttributionClause[^\n]*role === 'assessment'/,
    'buildSystemPrompt must inject assessmentConfigAttributionClause for role === assessment');
});

test('planning prompt also receives assessmentConfigAttributionClause', () => {
  assert.match(src, /role === 'planning'[^\n]*assessmentConfigAttributionClause|assessmentConfigAttributionClause[^\n]*role === 'planning'/,
    'buildSystemPrompt must inject assessmentConfigAttributionClause for role === planning');
});

// ── Gemini-conditional workaround clauses (gemini-gap-report.md) ──────────────

test('geminiPlanGuardClause defined and gated on planning role', () => {
  assert.match(src, /const geminiPlanGuardClause\s*=/, 'geminiPlanGuardClause constant must be defined');
  assert.ok(src.includes('GEMINI PLAN-PHASE GUARD'), 'plan guard must mention GEMINI PLAN-PHASE GUARD');
  assert.match(src, /role === 'planning'\)\s*prompt \+= geminiPlanGuardClause/, 'plan guard must be gated on planning role inside gemini branch');
});

test('geminiSubAgentSerialClause + geminiPermissionPromptGuardClause + geminiQuotaHardStopClause all injected under gemini provider branch', () => {
  assert.match(src, /const geminiSubAgentSerialClause\s*=/, 'subAgent serial clause must be defined');
  assert.match(src, /const geminiPermissionPromptGuardClause\s*=/, 'permission guard clause must be defined');
  assert.match(src, /const geminiQuotaHardStopClause\s*=/, 'quota hard-stop clause must be defined');
  assert.match(src, /_provId === 'gemini' \|\| _provId === 'gemini-vertex'/, 'buildSystemPrompt must branch on gemini or gemini-vertex provider id');
  assert.match(src, /prompt \+= geminiSubAgentSerialClause/, 'subAgent serial clause must be appended inside gemini branch');
  assert.match(src, /prompt \+= geminiPermissionPromptGuardClause/, 'permission guard clause must be appended inside gemini branch');
  assert.match(src, /prompt \+= geminiQuotaHardStopClause/, 'quota hard-stop clause must be appended inside gemini branch');
});

test('gemini clauses NOT injected unconditionally (must be inside provider-id branch)', () => {
  // Strip the buildSystemPrompt function body up to the gemini branch and confirm clauses
  // are not appended outside the conditional. Anchor: ensure each clause append occurs AFTER
  // the gemini branch open-line.
  const idx = src.indexOf("_provId === 'gemini'");
  assert.ok(idx > 0, 'gemini branch open must exist');
  const subAgentIdx = src.indexOf('prompt += geminiSubAgentSerialClause');
  assert.ok(subAgentIdx > idx, 'subAgent clause must be appended INSIDE the gemini branch (after the branch open)');
});

// ── system-prompt-additions per-role hook ─────────────────────────────────────

test('getSystemPromptAdditions function defined and reads system-prompt-additions', () => {
  assert.match(src, /function getSystemPromptAdditions\s*\(\s*role\s*\)/,
    'getSystemPromptAdditions(role) must be defined in run-agent.js');
  assert.match(src, /cfgRead\(\s*topicConfig\s*,\s*config\s*,\s*'system-prompt-additions'/,
    'getSystemPromptAdditions must read the system-prompt-additions key via cfgRead(topicConfig, config, ...)');
});

test('getSystemPromptAdditions handles array form by joining with \\n\\n', () => {
  const fnMatch = src.match(/function getSystemPromptAdditions[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'getSystemPromptAdditions function body must be extractable');
  assert.ok(/Array\.isArray/.test(fnMatch[0]) && /join\(['"]\\n\\n['"]\)/.test(fnMatch[0]),
    'array form must be joined with "\\n\\n"');
});

test('buildSystemPrompt appends getSystemPromptAdditions(role) AFTER outputFormattingMandateClause and gemini branch', () => {
  const fnMatch = src.match(/function buildSystemPrompt[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'buildSystemPrompt function body must be extractable');
  const body = fnMatch[0];
  const idxFormatting = body.indexOf('outputFormattingMandateClause');
  const idxGemini = body.indexOf("_provId === 'gemini'");
  const idxAdditions = body.indexOf('getSystemPromptAdditions(role)');
  assert.ok(idxFormatting >= 0, 'outputFormattingMandateClause must appear in buildSystemPrompt');
  assert.ok(idxGemini >= 0, 'gemini provider branch must appear in buildSystemPrompt');
  assert.ok(idxAdditions > idxFormatting, 'additions append must come AFTER outputFormattingMandateClause');
  assert.ok(idxAdditions > idxGemini, 'additions append must come AFTER the gemini branch so it lands LAST');
});

test('global-config.json declares default empty system-prompt-additions block for all three roles', () => {
  const gcRaw = fs.readFileSync(path.join(HARNESS, 'global-config.json'), 'utf8');
  // The JSONC file uses "// key" entries (valid JSON strings) — not comment syntax — so JSON.parse works directly.
  const gc = JSON.parse(gcRaw);
  assert.ok(gc['system-prompt-additions'], 'global-config.json must define a "system-prompt-additions" key');
  assert.ok('planning' in gc['system-prompt-additions'], 'must include planning entry');
  assert.ok('coding' in gc['system-prompt-additions'], 'must include coding entry');
  assert.ok('assessment' in gc['system-prompt-additions'], 'must include assessment entry');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
