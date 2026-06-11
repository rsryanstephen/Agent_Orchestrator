#!/usr/bin/env node
'use strict';

// Tests for use-claude-advisor-tool config flag and getAdvisorFlags helper.
// Run: node Agent_Orchestrator/tests/advisor-tool-config.test.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
const globalConfigSrc = fs.readFileSync(path.join(HARNESS, 'global-config.json'), 'utf8');

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

// ── Failing-grep contract ─────────────────────────────────────────────────────

test('claudeAdvisorClause defined in run-agent.js', () => {
  assert.ok(src.includes('claudeAdvisorClause'), 'claudeAdvisorClause must be defined in run-agent.js');
});

test('use-claude-advisor-tool comment line present in global-config.json', () => {
  assert.ok(
    globalConfigSrc.includes('"// use-claude-advisor-tool"'),
    'global-config.json must contain the // use-claude-advisor-tool comment key'
  );
});

test('use-claude-advisor-tool key present in global-config.json', () => {
  assert.ok(
    globalConfigSrc.includes('"use-claude-advisor-tool"'),
    'global-config.json must contain the use-claude-advisor-tool key'
  );
  const parsed = JSON.parse(
    globalConfigSrc.replace(/"\/\/[^"]*":\s*"[^"]*",?\n?/g, '')
  );
  assert.ok('use-claude-advisor-tool' in parsed, 'use-claude-advisor-tool key must parse from global-config.json');
});

// ── getAdvisorFlags behavioural tests ─────────────────────────────────────────

const { getAdvisorFlags, resetAdvisorWarned } = require(path.join(HARNESS, 'src', 'lib', 'advisor-flags'));

// (a) provider: "claude-code" + true shorthand -> all roles enabled
test('(a) claude-code + true -> all roles truthy', () => {
  resetAdvisorWarned();
  const flags = getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'claude-code');
  assert.strictEqual(flags.planning, true);
  assert.strictEqual(flags.coding, true);
  assert.strictEqual(flags.assessment, true);
});

// (a) all-false shorthand
test('(a) claude-code + false -> all roles falsy', () => {
  resetAdvisorWarned();
  const flags = getAdvisorFlags({ 'use-claude-advisor-tool': false }, 'claude-code');
  assert.strictEqual(flags.planning, false);
  assert.strictEqual(flags.coding, false);
  assert.strictEqual(flags.assessment, false);
});

// (b) per-role object form respects individual flags
test('(b) claude-code + object form {planning: true, coding: false, assessment: true}', () => {
  resetAdvisorWarned();
  const flags = getAdvisorFlags(
    { 'use-claude-advisor-tool': { planning: true, coding: false, assessment: true } },
    'claude-code'
  );
  assert.strictEqual(flags.planning, true);
  assert.strictEqual(flags.coding, false);
  assert.strictEqual(flags.assessment, true);
});

// (b) partial object - absent keys coerce to false
test('(b) claude-code + partial object {coding: true} -> only coding truthy', () => {
  resetAdvisorWarned();
  const flags = getAdvisorFlags(
    { 'use-claude-advisor-tool': { coding: true } },
    'claude-code'
  );
  assert.strictEqual(flags.planning, false);
  assert.strictEqual(flags.coding, true);
  assert.strictEqual(flags.assessment, false);
});

// (c) non-claude-code provider -> no clause, warning logged exactly once
test('(c) gemini + true -> all roles falsy', () => {
  resetAdvisorWarned();
  const flags = getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'gemini');
  assert.strictEqual(flags.planning, false);
  assert.strictEqual(flags.coding, false);
  assert.strictEqual(flags.assessment, false);
});

test('(c) gemini + true -> warning logged exactly once across two calls', () => {
  resetAdvisorWarned();
  const logs = [];
  const logFn = msg => logs.push(msg);
  getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'gemini', logFn);
  getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'gemini', logFn);
  assert.strictEqual(logs.length, 1, 'warning must fire exactly once regardless of call count');
  assert.ok(logs[0].includes('[INFO]'), 'warning must be an [INFO] log');
  assert.ok(logs[0].includes('gemini'), 'warning must mention the provider name');
});

test('(c) github-copilot + object truthy -> all roles falsy + warning once', () => {
  resetAdvisorWarned();
  const logs = [];
  const logFn = msg => logs.push(msg);
  const flags = getAdvisorFlags(
    { 'use-claude-advisor-tool': { planning: true } },
    'github-copilot',
    logFn
  );
  assert.strictEqual(flags.planning, false);
  assert.strictEqual(logs.length, 1);
});

// (d) default (key absent or false) -> no clause
test('(d) key absent -> all roles falsy, no warning', () => {
  resetAdvisorWarned();
  const logs = [];
  const flags = getAdvisorFlags({}, 'gemini', msg => logs.push(msg));
  assert.strictEqual(flags.planning, false);
  assert.strictEqual(flags.coding, false);
  assert.strictEqual(flags.assessment, false);
  assert.strictEqual(logs.length, 0, 'no warning when key absent');
});

test('(d) key false -> all roles falsy, no warning', () => {
  resetAdvisorWarned();
  const logs = [];
  const flags = getAdvisorFlags({ 'use-claude-advisor-tool': false }, 'gemini', msg => logs.push(msg));
  assert.strictEqual(flags.planning, false);
  assert.strictEqual(logs.length, 0, 'no warning when key is false');
});

// ── buildSystemPrompt wiring ──────────────────────────────────────────────────

test('buildSystemPrompt injects claudeAdvisorClause when advisorFlags[role] is true', () => {
  assert.match(
    src,
    /if\s*\(advisorFlags\[role\]\)\s*prompt \+= claudeAdvisorClause/,
    'buildSystemPrompt must conditionally append claudeAdvisorClause'
  );
});

test('claudeAdvisorClause references advisor-tool docs URL', () => {
  assert.ok(
    src.includes('advisor-tool'),
    'claudeAdvisorClause must reference advisor-tool docs'
  );
});

test('advisorFlags resolved from config at startup (before systemPrompts object)', () => {
  const advisorFlagsIdx = src.indexOf('const advisorFlags');
  const systemPromptsIdx = src.indexOf('const systemPrompts = {');
  assert.ok(advisorFlagsIdx !== -1, 'advisorFlags must be defined');
  assert.ok(systemPromptsIdx !== -1, 'systemPrompts object must exist');
  assert.ok(advisorFlagsIdx < systemPromptsIdx, 'advisorFlags must be resolved before systemPrompts is built');
});

// ── getAdvisorFlags bracket-access contract ───────────────────────────────────
// Verifies advisorFlags[role] indexing works for all valid role names at runtime.
// Catches a common refactor mistake: advisorFlags.role (always undefined) vs advisorFlags[role].

test('getAdvisorFlags[role] returns truthy for all roles when claude-code + true', () => {
  resetAdvisorWarned();
  const flags = getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'claude-code');
  for (const role of ['planning', 'coding', 'assessment']) {
    assert.ok(flags[role], `flags["${role}"] must be truthy when use-claude-advisor-tool=true and provider=claude-code`);
  }
});

test('getAdvisorFlags[role] returns falsy for all roles when non-claude-code provider', () => {
  resetAdvisorWarned();
  const flags = getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'gemini');
  for (const role of ['planning', 'coding', 'assessment']) {
    assert.ok(!flags[role], `flags["${role}"] must be falsy for non-claude-code provider`);
  }
});

test('_warned fires once per unique provider (Set semantics)', () => {
  resetAdvisorWarned();
  const logs = [];
  const logFn = msg => logs.push(msg);
  getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'gemini', logFn);
  getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'gemini', logFn);
  getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'github-copilot', logFn);
  getAdvisorFlags({ 'use-claude-advisor-tool': true }, 'github-copilot', logFn);
  assert.strictEqual(logs.length, 2, 'must warn once per unique non-claude-code provider');
  assert.ok(logs[0].includes('gemini'), 'first warning must mention gemini');
  assert.ok(logs[1].includes('github-copilot'), 'second warning must mention github-copilot');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
