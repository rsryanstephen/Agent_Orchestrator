#!/usr/bin/env node
'use strict';

// Regression tests for the 5-item plan (EINVAL fix, topics removal,
// topic-ids rename, output-verbosity doc, devils-advocate -> strict-assessment,
// minimal topic-config scaffold). Run:
//   node Agent_Orchestrator/tests/harness-config-rename.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
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

// ── Item 1: code.cmd EINVAL retry uses shell:true ─────────────────────────────
test('Item 1: saveAllVsCodeBuffers retries .cmd with shell:true on EINVAL/ENOENT', () => {
  // Retry path must handle BOTH ENOENT (bare `code` missing) and EINVAL (Node refuses
  // to spawn .cmd/.bat without shell:true since 18.20/20.12).
  assert.ok(/r\.error\.code === 'ENOENT' \|\| r\.error\.code === 'EINVAL'/.test(runAgentSrc),
    'expected combined ENOENT|EINVAL check in saveAllVsCodeBuffers retry');
  // Retry spawnSync MUST set shell:true.
  const retryBlock = runAgentSrc.match(/EINVAL[\s\S]{0,400}?spawnSync\([^)]+\{[^}]*shell:\s*true/);
  assert.ok(retryBlock, 'expected retry spawnSync to use shell:true');
});

// ── Item 2: topics removed, topic-ids rename ──────────────────────────────────
test('Item 2: global-config.json has no `topics` key', () => {
  assert.ok(!('topics' in globalCfg), '`topics` key should be removed from global-config.json');
});

test('Item 2: global-config.json declares `topic-ids` (not legacy `ids`)', () => {
  assert.ok(globalCfg['topic-ids'] && typeof globalCfg['topic-ids'] === 'object',
    '`topic-ids` map must be present');
  assert.ok(!('ids' in globalCfg), 'legacy `ids` key should be absent after rename');
});

test('Item 2: loadConfig migrates legacy `ids` -> `topic-ids` in-memory', () => {
  const tmp = path.join(os.tmpdir(), `legacy-cfg-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ ids: { '1': 'foo' }, 'use-caveman': true }, null, 2));
  try {
    const obj = configUtils.loadConfig(tmp);
    assert.deepStrictEqual(obj['topic-ids'], { '1': 'foo' });
    assert.ok(!('ids' in obj), 'legacy `ids` should be removed from in-memory object');
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

test('Item 2: loadConfig leaves modern `topic-ids` untouched', () => {
  const tmp = path.join(os.tmpdir(), `modern-cfg-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ 'topic-ids': { '1': 'foo' } }, null, 2));
  try {
    const obj = configUtils.loadConfig(tmp);
    assert.deepStrictEqual(obj['topic-ids'], { '1': 'foo' });
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

// ── Item 3: output-verbosity default 3 + caveman doc-comment ──────────────────
test('Item 3: output-verbosity default is 3 in global-config.json', () => {
  assert.strictEqual(globalCfg['output-verbosity'], 3);
});

test('Item 3: `// output-verbosity-and-caveman` doc-comment present', () => {
  assert.ok(globalCfgRaw.includes('"// output-verbosity-and-caveman"'),
    'inline doc-comment key `// output-verbosity-and-caveman` must be present');
  assert.ok(/caveman/i.test(globalCfgRaw.split('"// output-verbosity-and-caveman"')[1].slice(0, 400)),
    'doc-comment body should mention caveman interaction');
});

// ── Item 4: devils-advocate -> strict-assessment rename ───────────────────────
test('Item 4: skill folder renamed to strict-assessment, frontmatter name matches', () => {
  const skillPath = path.join(HARNESS, 'skills/strict-assessment/SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'strict-assessment SKILL.md must exist');
  const body = fs.readFileSync(skillPath, 'utf8');
  assert.ok(/^---[\s\S]*?\nname:\s*strict-assessment\b/m.test(body),
    'SKILL.md frontmatter `name:` should be `strict-assessment`');
  assert.ok(!fs.existsSync(path.join(HARNESS, 'skills/devils-advocate')),
    'old devils-advocate folder should be gone');
});

test('Item 4: run-agent.js uses resolveStrictAssessmentClause + new config key', () => {
  assert.ok(/resolveStrictAssessmentClause/.test(runAgentSrc), 'function rename missing');
  assert.ok(/useStrictAssessment/.test(runAgentSrc), 'config-key alias usage missing');
  assert.ok(/skills\/strict-assessment\/SKILL\.md/.test(runAgentSrc), 'skill path not updated');
  assert.ok(!/skills\/devils-advocate\/SKILL\.md/.test(runAgentSrc),
    'old skill path should be gone');
});

test('Item 4: global-config.json declares `use-strict-assessment`, legacy key absent', () => {
  assert.strictEqual(globalCfg['use-strict-assessment'], true);
  assert.ok(!('use-devils-advocate' in globalCfg),
    'legacy `use-devils-advocate` should be removed from global-config.json');
});

test('Item 4: loadConfig migrates legacy `use-devils-advocate` -> `use-strict-assessment`', () => {
  const tmp = path.join(os.tmpdir(), `legacy-da-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ 'use-devils-advocate': true }, null, 2));
  try {
    const obj = configUtils.loadConfig(tmp);
    assert.strictEqual(obj['use-strict-assessment'], true);
    assert.ok(!('use-devils-advocate' in obj), 'legacy key should be migrated away');
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

// ── Item 5: minimal topic-config.json scaffold ────────────────────────────────
test('Item 5: start-topic.js emits minimal topic-config (README + topic-id + prompt-file only)', () => {
  // Inspect the source so we don't have to invoke the script end-to-end (which
  // mutates global-config.json under a lock). Source-level invariants enforce
  // the contract.
  assert.ok(/'\/\/ README'/.test(startTopicSrc),
    '`// README` doc-comment key must be scaffolded');
  assert.ok(/'topic-id':\s*numericId/.test(startTopicSrc),
    '`topic-id` must be scaffolded (replaces legacy `id`)');
  assert.ok(/'prompt-file':\s*`\$\{topicName\}\.md`/.test(startTopicSrc),
    '`prompt-file` must be scaffolded');
  // The previous scaffolder seeded models / model-effort / context-files —
  // those must NOT be in the new minimal output.
  const scaffoldStart = startTopicSrc.indexOf('const topicConfig = {');
  const scaffoldEnd = startTopicSrc.indexOf('};', scaffoldStart);
  const scaffoldBlock = startTopicSrc.slice(scaffoldStart, scaffoldEnd + 2);
  assert.ok(!/models/.test(scaffoldBlock),
    '`models` must NOT be pre-seeded (cascades from global-config.json)');
  assert.ok(!/model-effort/.test(scaffoldBlock),
    '`model-effort` must NOT be pre-seeded');
  assert.ok(!/use-caveman|auto-answer-clarifying-questions/.test(scaffoldBlock),
    'no other global-config keys should be pre-seeded');
});

test('Item 5: scaffolded README body explains override behaviour', () => {
  assert.ok(/override.*global-config\.json/i.test(startTopicSrc),
    'README scaffold body should explain that topic-config overrides global-config.json');
});

// ── Item 6: auto-answer -> auto-answer-clarifying-questions rename ────────────
test('Item 6: cfgRead resolves `auto-answer-clarifying-questions` from global config', () => {
  // Positive end-to-end test: confirm the kebab->camel alias actually surfaces
  // the configured value via cfgRead (catches kebab/camel key-mapping regressions).
  const v = configUtils.cfgRead(null, globalCfg, 'auto-answer-clarifying-questions');
  assert.strictEqual(v, false, 'cfgRead should return the configured `auto-answer-clarifying-questions` value (default is false per README)');
});

test('Item 6: cfgRead resolves `auto-answer-clarifying-questions-and-submit` from global config', () => {
  const v = configUtils.cfgRead(null, globalCfg, 'auto-answer-clarifying-questions-and-submit');
  assert.strictEqual(v, false, 'cfgRead should return the configured `-and-submit` value');
});

test('Item 6: legacy `auto-answer` and `auto-answer-and-submit` keys absent from global config', () => {
  assert.ok(!('auto-answer' in globalCfg), 'legacy `auto-answer` key must be gone');
  assert.ok(!('auto-answer-and-submit' in globalCfg), 'legacy `auto-answer-and-submit` key must be gone');
});

test('Item 6: state-file path uses new `last-auto-answer-clarifying-questions-<topic>.json` pattern', () => {
  assert.ok(/last-auto-answer-clarifying-questions-\$\{topicName\}\.json/.test(runAgentSrc),
    'state-file template must use new kebab prefix');
  assert.ok(!/last-auto-answer-\$\{topicName\}\.json/.test(runAgentSrc),
    'legacy state-file template should be gone');
});

test('Item 6: topic-config camel key matches kebabToCamel mapping (not doubled fn name)', () => {
  // Guards against accidental binding to the doubled fn identifier
  // (`autoAnswerClarifyingQuestionsClarifyingQuestions`) — config reads MUST
  // use the single-suffix camel `autoAnswerClarifyingQuestions`.
  assert.ok(/topicConfig\.autoAnswerClarifyingQuestions\b/.test(runAgentSrc),
    'topicConfig read must use single-suffix camel key');
  assert.ok(/topicConfig\.autoAnswerClarifyingQuestionsAndSubmit\b/.test(runAgentSrc),
    'topicConfig read for and-submit must use single-suffix camel key');
});
