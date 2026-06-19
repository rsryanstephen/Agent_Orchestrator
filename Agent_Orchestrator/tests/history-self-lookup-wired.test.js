#!/usr/bin/env node
/**
 * Regression: history-self-lookup SKILL.md must be wired into run-agent.js
 * MAIN-role payloads (planning, coding-from-plan, coding, assessment, fix)
 * and must NOT leak into the parallel fan-out paths, whose subtask prompts
 * stay deterministic/self-contained.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { _failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

test('run-agent.js defines buildHistorySelfLookupBlock', () => {
  assert.ok(/function\s+buildHistorySelfLookupBlock\b/.test(RUN_AGENT_SRC),
    'buildHistorySelfLookupBlock function must be defined');
});

test('buildHistorySelfLookupBlock substitutes all three placeholders', () => {
  const start = RUN_AGENT_SRC.indexOf('function buildHistorySelfLookupBlock(');
  const end = RUN_AGENT_SRC.indexOf('\n}', start);
  const body = RUN_AGENT_SRC.slice(start, end);
  assert.ok(/<promptHistoryFile>/.test(body), 'must substitute <promptHistoryFile>');
  assert.ok(/<historyLineCount>/.test(body), 'must substitute <historyLineCount>');
  assert.ok(/<queueFile>/.test(body), 'must substitute <queueFile>');
});

test('skill block is wired into all 5 main roles', () => {
  // One definition + 5 call sites (one per main role).
  const calls = (RUN_AGENT_SRC.match(/buildHistorySelfLookupBlock\s*\(\s*historyPath\s*\)/g) || []).length;
  assert.strictEqual(calls, 5, `expected 5 main-role call sites, found ${calls}`);
  // Each main payload prepends the block to its system prompt.
  const prepends = (RUN_AGENT_SRC.match(/historySelfLookup\s*\+/g) || []).length;
  assert.ok(prepends >= 5, `expected >=5 historySelfLookup prepends, found ${prepends}`);
});

test('skill block injects the section header literal', () => {
  assert.ok(/History Self-Lookup \(skill\)/.test(RUN_AGENT_SRC),
    'the skill section header must be embedded in the block builder');
});

test('parallel fan-out paths do NOT reference the skill block', () => {
  // Parallel subtask builders must stay self-contained — assert the helper
  // is not called inside any *Parallel function.
  for (const fn of ['runCodingParallel', 'runAssessmentParallel', 'runCodingAssessmentParallel', 'validateParallelPremises']) {
    const start = RUN_AGENT_SRC.indexOf(`async function ${fn}(`);
    if (start < 0) continue;
    const next = RUN_AGENT_SRC.indexOf('\nasync function ', start + 1);
    const slice = RUN_AGENT_SRC.slice(start, next < 0 ? undefined : next);
    assert.ok(!/buildHistorySelfLookupBlock\s*\(/.test(slice),
      `${fn} must not wire the history-self-lookup skill`);
  }
});

test('CONTEXT_TRUNCATION constant and slice are removed', () => {
  assert.ok(!/CONTEXT_TRUNCATION/.test(RUN_AGENT_SRC),
    'CONTEXT_TRUNCATION must be fully removed');
  assert.ok(!/truncated to save tokens/.test(RUN_AGENT_SRC),
    'the agent-response truncation slice must be removed');
});

test('SKILL.md remains on disk', () => {
  const skillPath = path.join(HARNESS, 'skills', 'history-self-lookup', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'SKILL.md must exist');
  assert.ok(fs.readFileSync(skillPath, 'utf8').length > 0, 'SKILL.md must not be empty');
});

if (_failed) { console.error(`\n${_failed} test(s) failed`); process.exit(1); }
console.log('\nAll history-self-lookup-wired tests passed.');
