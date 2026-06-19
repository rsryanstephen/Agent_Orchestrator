#!/usr/bin/env node
'use strict';

/**
 * Behavioural gate test for the opt-in `regression-test` skill (`use-regression-skill`).
 *
 * Discipline (regression-test skill / diagnostic H1): NO source-grep for logic.
 * The gate logic lives in the PURE, exported `resolveRegressionSkillClauseFor`
 * (defined before run-agent.js's require-surface early-return, so callable from a
 * require() without the CLI bootstrap or buildSystemPrompt's TDZ). Every case
 * calls that real function with synthetic configs and asserts on the clause string
 * the model would actually receive — deterministic, no spawn race.
 *
 * Why not spawn the binary: `run-agent.js <topic> <role>` runs the WHOLE pipeline
 * and each phase OVERWRITES the shared payload-dump file, so a captured prompt is
 * non-deterministic by role (the source of intermittent failures). Driving the
 * exported resolver is the reliable public-surface seam for the gate; the
 * inline-defaults membership is a static-array fact (the regression-test skill's
 * one sanctioned static check).
 *
 * Run: node Agent_Orchestrator/tests/use-regression-skill-gate.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const SKILL_PATH = path.join(HARNESS, 'skills', 'regression-test', 'SKILL.md');
const { resolveRegressionSkillClauseFor } = require(RUN_AGENT);

// Distinctive markers (kept in sync with run-agent.js + SKILL.md).
const CODING_HEADER = '## Regression-Test Discipline (mandatory)';
const ASSESSMENT_HEADER = '## Regression-Test Discipline (assessment — mandatory)';
const ASSESSMENT_PREAMBLE = 'hold them to this discipline';
const SKILL_BODY_LINE = 'Drive the public surface, not the source text.';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e && (e.stack || e.message || e)}`); }
}

// Requirement: "gate-off omits clause".
test('gate OFF (key absent): empty clause for coding and assessment', () => {
  assert.strictEqual(resolveRegressionSkillClauseFor({}, {}, 'coding'), '');
  assert.strictEqual(resolveRegressionSkillClauseFor({}, {}, 'assessment'), '');
});

test('gate OFF (key false): empty clause', () => {
  assert.strictEqual(resolveRegressionSkillClauseFor({ 'use-regression-skill': false }, {}, 'coding'), '');
});

// Requirement: "gate-on injects body into coding+assessment".
test('gate ON: coding clause carries the coding header + SKILL.md body', () => {
  const c = resolveRegressionSkillClauseFor({ 'use-regression-skill': true }, {}, 'coding');
  assert.ok(c.includes(CODING_HEADER), 'coding header present');
  assert.ok(c.includes(SKILL_BODY_LINE), 'SKILL.md body inlined');
  assert.ok(!c.includes('(assessment — mandatory)'), 'coding clause is not the assessment variant');
});

test('gate ON: assessment clause carries the audit header + preamble + body', () => {
  const a = resolveRegressionSkillClauseFor({ 'use-regression-skill': true }, {}, 'assessment');
  assert.ok(a.includes(ASSESSMENT_HEADER), 'assessment header present');
  assert.ok(a.includes(ASSESSMENT_PREAMBLE), 'assessment audit preamble present');
  assert.ok(a.includes(SKILL_BODY_LINE), 'SKILL.md body inlined');
});

// Requirement: "gated on `topicConfig.useRegressionSkill ?? config.useRegressionSkill`" (cascade).
test('global cascade: topic absent + global true enables the clause', () => {
  const c = resolveRegressionSkillClauseFor({}, { 'use-regression-skill': true }, 'coding');
  assert.ok(c.includes(CODING_HEADER), 'global value enables clause');
});

test('topic overrides global: topic false beats global true', () => {
  const c = resolveRegressionSkillClauseFor({ 'use-regression-skill': false }, { 'use-regression-skill': true }, 'coding');
  assert.strictEqual(c, '', 'topic false wins over global true');
});

test('camelCase key form honored (kebab/camel interop)', () => {
  const c = resolveRegressionSkillClauseFor({ useRegressionSkill: true }, {}, 'coding');
  assert.ok(c.includes(CODING_HEADER), 'camelCase use-regression-skill alias resolves');
});

// Requirement: "independence from `regression-tests`".
test('independence: regression-tests=true alone does NOT enable the skill', () => {
  assert.strictEqual(resolveRegressionSkillClauseFor({ 'regression-tests': true }, {}, 'coding'), '');
});

test('independence: skill ON while regression-tests OFF still injects', () => {
  const c = resolveRegressionSkillClauseFor({ 'use-regression-skill': true, 'regression-tests': false }, {}, 'coding');
  assert.ok(c.includes(CODING_HEADER), 'skill clause is independent of regression-tests flag');
});

// Requirement: "missing-file warn-not-throw". Inject a fake fs + log so the real
// SKILL.md on disk is never disturbed (no rename race with concurrent runs).
test('missing SKILL.md with gate ON: warns once, returns empty, does not throw', () => {
  const warned = [];
  const fakeFs = { existsSync: () => false, readFileSync: () => { throw new Error('must not read'); } };
  let out;
  assert.doesNotThrow(() => {
    out = resolveRegressionSkillClauseFor(
      { 'use-regression-skill': true }, {}, 'coding',
      { fs: fakeFs, log: m => warned.push(m), skillPath: '/no/such/SKILL.md' }
    );
  });
  assert.strictEqual(out, '', 'no clause when the skill file is missing');
  assert.strictEqual(warned.length, 1, 'exactly one warning emitted');
  assert.ok(/not found/i.test(warned[0]), 'warning explains the missing file');
});

// Requirement: "add `'regression-test'` to `SKILLS_INLINE_DEFAULTS`". Static-array
// membership has no require()-reachable runtime surface (the const lives past
// run-agent.js's early-return); per the regression-test skill's own rule this is
// the single tolerated static check. Paired with a real-artifact assertion that
// the inlined body exists and fits the 8 KB inline cap.
test('regression-test is inline-registered and the SKILL.md artifact is valid', () => {
  const src = fs.readFileSync(RUN_AGENT, 'utf8');
  const m = src.match(/const SKILLS_INLINE_DEFAULTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'SKILLS_INLINE_DEFAULTS array must be declared');
  assert.ok(/['"]regression-test['"]/.test(m[1]), "'regression-test' must be in SKILLS_INLINE_DEFAULTS");
  assert.ok(fs.existsSync(SKILL_PATH), 'regression-test SKILL.md must exist');
  const bytes = Buffer.byteLength(fs.readFileSync(SKILL_PATH, 'utf8'), 'utf8');
  assert.ok(bytes > 0 && bytes <= 8 * 1024, `SKILL.md must be non-empty and within the 8 KB inline cap (got ${bytes}B)`);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
