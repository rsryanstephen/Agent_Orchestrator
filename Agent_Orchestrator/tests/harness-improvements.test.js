#!/usr/bin/env node
'use strict';

// Regression tests for plan items 1-8 (harness improvements).
// Run: node Agent_Orchestrator/tests/harness-improvements.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const GLOBAL = path.join(HARNESS, 'global-config.json');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const START_TOPIC = path.join(HARNESS, 'src', 'start-topic.js');

const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');
const startTopicSrc = fs.readFileSync(START_TOPIC, 'utf8');
const globalCfgRaw = fs.readFileSync(GLOBAL, 'utf8');
const globalCfg = configUtils.loadConfig(GLOBAL);

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── Item 1 ────────────────────────────────────────────────────────────────────
test('Item 1a: lastAgentResponseContainsClarifyingQuestions injects synthetic header for numbered list w/o header', () => {
  // Numbered-list fallback regex + injection wiring present.
  assert.ok(/Fallback \(Item 1c\)/.test(runAgentSrc), 'fallback comment missing');
  assert.ok(/numberedRe = \/\^\\s\*\\d\+\\\.\\s\+/.test(runAgentSrc), 'numbered regex missing');
  assert.ok(/Detected numbered question list without `## Clarifying Questions` header/.test(runAgentSrc));
});

test('Item 1b: planningGrillClause + downstreamGrillClause mandate verbatim header', () => {
  assert.ok(/header is EXACTLY the literal string.*## Clarifying Questions/s.test(runAgentSrc),
    'verbatim header mandate missing');
  // Both clauses must include the mandate string.
  const occurrences = (runAgentSrc.match(/header is EXACTLY the literal string/g) || []).length;
  assert.ok(occurrences >= 2, `expected ≥2 grill clauses w/ verbatim mandate, got ${occurrences}`);
});

// ── Items 2 + 4 ───────────────────────────────────────────────────────────────
test('Item 2: global-config.json declares auto-answer-clarifying-questions-and-submit=false w/ comment', () => {
  assert.strictEqual(globalCfg['auto-answer-clarifying-questions-and-submit'], false);
  assert.ok(globalCfgRaw.includes('"// auto-answer-clarifying-questions-and-submit"'),
    'inline `// auto-answer-clarifying-questions-and-submit` comment missing');
});

// Requirement: setting `auto-answer-clarifying-questions-and-submit: true` alone (without
// `auto-answer-clarifying-questions`) must be sufficient — submit implies auto-answer.
test('Item 2: auto-answer-clarifying-questions-and-submit implies auto-answer-clarifying-questions', () => {
  // autoSubmit resolved independently, then autoAnswerClarifyingQuestions = explicit || autoSubmit.
  assert.ok(/const autoAnswerClarifyingQuestions = explicitAutoAnswer \|\| autoSubmit/.test(runAgentSrc),
    'autoAnswerClarifyingQuestions must be derived as `explicitAutoAnswer || autoSubmit` so submit implies auto-answer');
  assert.ok(/const autoSubmit = \(topicConfig\.autoAnswerClarifyingQuestionsAndSubmit != null\)/.test(runAgentSrc),
    'autoSubmit must be resolved from topic/global cascade independently of autoAnswerClarifyingQuestions');
});

test('Item 2: when auto-answer-clarifying-questions-and-submit=true, promptForUserReply is skipped', () => {
  // Look for early-return branch that skips promptForUserReply.
  assert.ok(/autoSubmit && autoAnswerClarifyingQuestions && !userAuthored/.test(runAgentSrc),
    'skip-prompt branch missing');
  assert.ok(/auto-answer-clarifying-questions-and-submit=true — proceeding without manual confirmation/.test(runAgentSrc));
});

test('Item 2: user-authored replies still pause (no silent submit)', () => {
  // The skip branch must AND `!userAuthored` so user edits aren't auto-submitted.
  const branchMatch = runAgentSrc.match(/if \(autoSubmit && autoAnswerClarifyingQuestions && !userAuthored\)/);
  assert.ok(branchMatch, 'skip branch must include !userAuthored guard');
});

test('Item 4: global-config.json includes `// models` and `// model-effort` comments', () => {
  assert.ok(globalCfgRaw.includes('"// models"'), 'models comment missing');
  assert.ok(globalCfgRaw.includes('"// model-effort"'), 'model-effort comment missing');
});

test('Item 4: global-config.json declares actual `models` + `model-effort` keys (not just comments)', () => {
  assert.ok(globalCfg.models && typeof globalCfg.models === 'object',
    '`models` key missing at global level — comments alone are insufficient');
  assert.ok(globalCfg['model-effort'] && typeof globalCfg['model-effort'] === 'object',
    '`model-effort` key missing at global level');
  for (const role of ['planning', 'coding', 'assessment']) {
    assert.strictEqual(globalCfg.models[role], 'auto', `models.${role} must default to "auto"`);
    assert.strictEqual(globalCfg['model-effort'][role], 'auto', `model-effort.${role} must default to "auto"`);
  }
});

test('Item 4: restoreGlobalAutoModelFields invoked in BOTH success + error path of run-agent main', () => {
  // Strip the function definition line, then count remaining invocations.
  const withoutDef = runAgentSrc.replace(/function restoreGlobalAutoModelFields\([^)]*\)\s*\{/, '');
  const calls = (withoutDef.match(/restoreGlobalAutoModelFields\(\)/g) || []).length;
  assert.ok(calls >= 2, `expected ≥2 invocations (success path + catch path), got ${calls}`);
});

test('Item 4: hasComments is string-aware (no false-positive on `"//"` JSON keys)', () => {
  // Prevents restoreGlobalAutoModelFields bailing on global-config.json which uses "// key" entries.
  assert.strictEqual(configUtils.hasComments('{"// foo": "bar"}'), false,
    'JSON-string `//` keys must not register as comments');
  assert.strictEqual(configUtils.hasComments('// real comment\n{}'), true,
    'genuine `//` line comment must still be detected');
  assert.strictEqual(globalCfg.__hasComments, false,
    'global-config.json (no real comments) must report __hasComments=false');
});

test('Item 4: restoreGlobalAutoModelFields exists + invoked in finish path', () => {
  assert.ok(/function restoreGlobalAutoModelFields\(/.test(runAgentSrc), 'helper missing');
  // Must be called in both success + error paths after restoreAutoModelFields.
  const calls = (runAgentSrc.match(/restoreGlobalAutoModelFields\(\)/g) || []).length;
  assert.ok(calls >= 2, `expected ≥2 invocations (success + error path), got ${calls}`);
});

test('Item 4 (superseded by minimal-scaffold): auto-answer-clarifying-questions-and-submit is never pre-seeded into topic-config', () => {
  // start-topic.js now emits a minimal topic-config (README + topic-id + prompt-file).
  // Global-only keys like auto-answer-clarifying-questions-and-submit cascade via cfgRead and must NOT
  // appear in the scaffold block.
  const scaffoldStart = startTopicSrc.indexOf('const topicConfig = {');
  const scaffoldEnd = startTopicSrc.indexOf('};', scaffoldStart);
  const block = startTopicSrc.slice(scaffoldStart, scaffoldEnd + 2);
  assert.ok(!/auto-answer-clarifying-questions-and-submit|autoAnswerClarifyingQuestionsAndSubmit/.test(block),
    'auto-answer-clarifying-questions-and-submit must not be pre-seeded into topic-config scaffold');
});

// ── Items 3 + 5 ───────────────────────────────────────────────────────────────
test('Item 3: regressionClause mandates ≥1 test per requirement bullet', () => {
  assert.ok(/MANDATORY \(regression-tests=true\)/.test(runAgentSrc),
    'mandatory clause missing from coding regressionClause');
  assert.ok(/AT LEAST ONE regression test per requirement bullet/.test(runAgentSrc));
});

test('Item 3: assessment agent gets matching audit clause', () => {
  assert.ok(/regressionAssessmentClause/.test(runAgentSrc), 'assessment audit clause missing');
  assert.ok(/AUDIT \(regression-tests=true\)/.test(runAgentSrc));
  assert.ok(/flag any missing test coverage as a BLOCKER/.test(runAgentSrc));
  // Must be appended in buildSystemPrompt for the assessment role.
  assert.ok(/if \(role === 'assessment'\) prompt \+= regressionAssessmentClause/.test(runAgentSrc));
});

test('Item 5: applyRateLimitDowngrade exists + downgrades opus→sonnet at <20%', () => {
  assert.ok(/function applyRateLimitDowngrade\(/.test(runAgentSrc), 'helper missing');
  assert.ok(/rate-limit <20% → downgraded opus→sonnet/.test(runAgentSrc));
});

test('Item 5 (clarified): budget path NEVER downgrades to haiku — only opus→sonnet', () => {
  // User explicitly: "do not downgrade to Haiku, regardless of how few tokens are left,
  // only downgrade to sonnet level when assessing token availability."
  assert.ok(!/rate-limit <5% → forced haiku/.test(runAgentSrc),
    'haiku-forcing branch must be removed — budget path is opus→sonnet only');
  assert.ok(!/rate-limit <20% → downgraded sonnet→haiku/.test(runAgentSrc),
    'sonnet→haiku branch must be removed — haiku only via complexity classifier');
  // Haiku is still reachable via `autoClassifyModel` for truly simple tasks.
  assert.ok(/function autoClassifyModel/.test(runAgentSrc));
  assert.ok(/LATEST_HAIKU/.test(runAgentSrc), 'haiku constant kept for complexity-path use');
});

test('Item 5: downgrade only active for `auto` model selection (not explicit pins)', () => {
  // Downgrade call must live inside the `modelId === 'auto'` branch.
  const autoBlock = runAgentSrc.match(/if \(modelId === 'auto'\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(autoBlock, 'auto branch not found');
  assert.ok(/applyRateLimitDowngrade/.test(autoBlock[1]),
    'downgrade must be inside auto branch — explicit model pins should not be silently downgraded');
});

// ── Items 6 + 7 ───────────────────────────────────────────────────────────────
test('Items 6+7: per-call --session-id passed to claude CLI', () => {
  assert.ok(/'--session-id', sessionId/.test(runAgentSrc),
    'session-id arg missing — chat history will leak into VS Code interactive session');
});

test('Items 6+7: CLAUDE_SESSION_DIR + ANTHROPIC_PROJECT_DIR env set to ephemeral path', () => {
  assert.ok(/CLAUDE_SESSION_DIR: harnessSessionDir/.test(runAgentSrc));
  assert.ok(/ANTHROPIC_PROJECT_DIR: harnessSessionDir/.test(runAgentSrc));
  assert.ok(/'\.state', 'sessions', sessionId/.test(runAgentSrc),
    'ephemeral session dir path missing');
});

// ── Item 8 ────────────────────────────────────────────────────────────────────
test('Item 8: "Unsaved editor buffers" warning removed from stdout/log path', () => {
  assert.ok(!/Unsaved editor buffers will NOT be flushed/.test(runAgentSrc),
    'old log message still present — would pollute history');
  assert.ok(!/Unsaved buffers may be missed/.test(runAgentSrc),
    'old throw-branch log message still present');
});

test('Item 8: silent-failure flag mechanism preserved (stderr-only diagnostic)', () => {
  assert.ok(/_vsCodeSaveFailureLogged/.test(runAgentSrc), 'silent flag removed');
  // Editor-agnostic rename: diagnostic now says `editor-save-all-command`.
  assert.ok(/console\.error\(`editor-save-all-command unavailable/.test(runAgentSrc),
    'stderr diagnostic missing — would mask broken editor CLI');
});

// ── Cascade sanity ─────────────────────────────────────────────────────────────
test('cfgRead cascade: auto-answer-clarifying-questions-and-submit topic override beats global', () => {
  const topicOn = { 'auto-answer-clarifying-questions-and-submit': true };
  const topicOff = { 'auto-answer-clarifying-questions-and-submit': false };
  assert.strictEqual(configUtils.cfgRead(topicOn, globalCfg, 'auto-answer-clarifying-questions-and-submit', false), true);
  assert.strictEqual(configUtils.cfgRead(topicOff, globalCfg, 'auto-answer-clarifying-questions-and-submit', true), false);
  assert.strictEqual(configUtils.cfgRead(null, globalCfg, 'auto-answer-clarifying-questions-and-submit', true), false);
});

// ── Item 1 (tightened) ────────────────────────────────────────────────────────
test('Item 1 (tightened): synthetic header injection requires ≥1 numbered question line (lowered from ≥2)', () => {
  // Threshold lowered to ≥1; false-positive guard tightened by `firstIsOne` + block-size > 50.
  assert.ok(/questionLines\.length >= 1/.test(runAgentSrc),
    'must require ≥1 numbered question line');
  assert.ok(!/questionLines\.length >= 2/.test(runAgentSrc),
    'old ≥2 threshold must be removed');
  assert.ok(/\\\?\\s\*\$/.test(runAgentSrc),
    'must anchor `?` to end of line so numbered code/list bullets do not register');
  assert.ok(/!hasCodeHeader/.test(runAgentSrc),
    'false-positive guard: bail if a `## Code` header precedes the numbered list');
  assert.ok(/firstIsOne/.test(runAgentSrc),
    'false-positive guard: list must start at 1. not arbitrary N');
  assert.ok(/\.trim\(\)\.length > 50/.test(runAgentSrc),
    'false-positive guard: block must be > 50 chars');
});

// ── Item 2 (clarified — auto-submit heading) ──────────────────────────────────
test('Item 2 (clarified): auto-submit path writes under `## Auto Reply to Clarifying Questions` heading', () => {
  assert.ok(/AUTO_REPLY_HEADER = 'Auto Reply to Clarifying Questions'/.test(runAgentSrc),
    'AUTO_REPLY_HEADER constant missing');
  assert.ok(/headerName = autoSubmit \? AUTO_REPLY_HEADER : USER_REPLY_HEADER/.test(runAgentSrc),
    'handleClarifyingQuestionsIfAny must switch heading by autoSubmit flag');
  assert.ok(/autoAnswerClarifyingQuestionsClarifyingQuestions\(questions, \{ headerName \}\)/.test(runAgentSrc),
    'autoAnswerClarifyingQuestionsClarifyingQuestions must accept headerName option');
});

test('Item 2 (clarified): readUserReplyFromHistory recognises BOTH headings', () => {
  const m = runAgentSrc.match(/User Reply to Questions\|Auto Reply to Clarifying Questions/g) || [];
  assert.ok(m.length >= 1, 'readUserReplyFromHistory regex must accept either heading');
  // parseConversationContext headerSplit must also accept the new heading.
  assert.ok(/Auto Reply to Clarifying Questions\|Auto Answer/.test(runAgentSrc),
    'headerSplit in parseConversationContext must include the new heading');
});

test('Item 2 (clarified): no-Enter-twice path — early return BEFORE promptForUserReply', () => {
  // The skip-prompt branch (`if (autoSubmit && autoAnswerClarifyingQuestions && !userAuthored)`)
  // must `return true` before the `promptForUserReply()` call site.
  const idxSkip = runAgentSrc.indexOf('auto-answer-clarifying-questions-and-submit=true — proceeding without manual confirmation');
  const idxPrompt = runAgentSrc.indexOf('await promptForUserReply(');
  assert.ok(idxSkip > 0 && idxPrompt > 0, 'expected markers missing');
  assert.ok(idxSkip < idxPrompt,
    'skip-return must occur before promptForUserReply call site (Enter-twice avoided)');
  const between = runAgentSrc.slice(idxSkip, idxPrompt);
  assert.ok(/return true/.test(between), 'skip branch must `return true` before prompting');
});

test('Item 2 (clarified): auto-submit footer note distinguishes itself from pause-and-wait fill', () => {
  assert.ok(/auto-submitted, no manual confirmation/.test(runAgentSrc),
    'auto-submit footer note missing — UX needs distinct marker from pause-and-wait fill');
});

// Requirement: `auto-answer-clarifying-questions-and-submit: true` implies auto-answer enabled.
test('Item 2: autoSubmit implies autoAnswerClarifyingQuestions (submit alone is sufficient)', () => {
  // submit resolved first/independently; autoAnswer = explicit || autoSubmit. When submit=true,
  // autoAnswer becomes true even if explicit auto-answer is false/unset.
  assert.ok(/const autoAnswerClarifyingQuestions = explicitAutoAnswer \|\| autoSubmit/.test(runAgentSrc),
    'submit-implies-auto-answer wiring missing');
});

// ── Item 4 sanity: snapshot taken at prompt START via top-level IIFE captures ────
test('Item 4 (snapshot semantics): originalAutoRoles + originalGlobalAutoRoles captured at module load', () => {
  // Both must be `const` IIFEs at module top-level (executed once at prompt START
  // before any phase mutates topic/global config).
  assert.ok(/const originalAutoRoles = \(\(\) => \{/.test(runAgentSrc),
    'originalAutoRoles snapshot must be top-level IIFE (prompt-START semantics)');
  assert.ok(/const originalGlobalAutoRoles = \(\(\) => \{/.test(runAgentSrc),
    'originalGlobalAutoRoles snapshot must be top-level IIFE');
  // Restore must compare against snapshot, not config default — verified by the
  // loop body iterating `originalAutoRoles[camelKey]`.
  assert.ok(/for \(const role of originalAutoRoles\[camelKey\]\)/.test(runAgentSrc),
    'restoreAutoModelFields must iterate snapshot, not fresh config');
  assert.ok(/for \(const role of originalGlobalAutoRoles\[camelKey\]\)/.test(runAgentSrc),
    'restoreGlobalAutoModelFields must iterate snapshot, not fresh config');
});

if (!process.exitCode) console.log('\nAll regression tests passed.');
