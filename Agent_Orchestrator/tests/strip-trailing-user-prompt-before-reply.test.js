#!/usr/bin/env node
'use strict';

// Regression test for Bug #1c: handleClarifyingQuestionsIfAny must remove the
// empty trailing `## User Prompt` placeholder (left by the prior phase's
// `appendUserPromptSuffix: true`) BEFORE writing the auto-answer-clarifying-questions / fallback
// `## User Reply to Questions` block. Otherwise the history file ends up with a
// redundant `## User Prompt` + `---` divider sandwiched between the planning
// response and the reply block.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// (1) Source-level: handleClarifyingQuestionsIfAny invokes stripTrailingUserPrompt
//     BEFORE the autoAnswerClarifyingQuestionsClarifyingQuestions call AND before the fallback
//     appendToFile('## User Reply to Questions', ...).
test('source: stripTrailingUserPrompt called before autoAnswerClarifyingQuestionsClarifyingQuestions', () => {
  const idx = runAgentSrc.indexOf('async function handleClarifyingQuestionsIfAny');
  assert.ok(idx >= 0, 'handleClarifyingQuestionsIfAny must exist');
  const slice = runAgentSrc.slice(idx, idx + 4000);
  const stripIdx = slice.indexOf('stripTrailingUserPrompt(historyPath)');
  const autoIdx = slice.indexOf('autoAnswerClarifyingQuestionsClarifyingQuestions(questions');
  assert.ok(stripIdx > 0, 'stripTrailingUserPrompt(historyPath) must appear in handleClarifyingQuestionsIfAny');
  assert.ok(autoIdx > 0 && stripIdx < autoIdx,
    'stripTrailingUserPrompt must run BEFORE autoAnswerClarifyingQuestionsClarifyingQuestions');
});

test('source: stripTrailingUserPrompt called before fallback appendToFile(`## User Reply to Questions`...)', () => {
  const idx = runAgentSrc.indexOf('async function handleClarifyingQuestionsIfAny');
  const slice = runAgentSrc.slice(idx, idx + 4000);
  // The fallback branch (`else if (!existingReply)`) appends an empty reply
  // block. The strip call must be inside that branch before the append.
  const branchMatch = slice.match(/else if \(!existingReply\) \{([\s\S]*?)\}/);
  assert.ok(branchMatch, 'expected `else if (!existingReply)` fallback branch');
  const branchBody = branchMatch[1];
  const stripIdx = branchBody.indexOf('stripTrailingUserPrompt(historyPath)');
  const appendIdx = branchBody.indexOf("appendToFile(historyPath, '## User Reply to Questions'");
  assert.ok(stripIdx >= 0, 'stripTrailingUserPrompt must be called in fallback branch');
  assert.ok(appendIdx > stripIdx,
    'stripTrailingUserPrompt must run BEFORE appendToFile(`## User Reply to Questions`)');
});

// (2) Behavioural: stripTrailingUserPrompt actually removes the trailing
//     `## User Prompt` (+ optional `---` divider) — pure-fn test against the
//     real helper-shaped regex copied from run-agent.js:501-505.
function stripTrailingUserPrompt(content) {
  return content.replace(/(?:\n+(?:---\s*\n+)?)## User Prompt\s*\n*$/, '');
}

test('behaviour: trailing `## User Prompt\\n\\n---\\n\\n## User Prompt\\n` placeholder is stripped', () => {
  const seeded =
    '# claude_harness - chat history\n\n' +
    '## Planning Agent Response\n\n' +
    '1. Should we use foo? \n\n' +
    '---\n\n' +
    '## User Prompt\n\n';
  const stripped = stripTrailingUserPrompt(seeded);
  // After strip, the file must end with the planning block — no trailing `## User Prompt`.
  assert.ok(!/## User Prompt\s*$/m.test(stripped.trim()) || stripped.indexOf('## User Prompt') < 0,
    `expected no trailing '## User Prompt' header; got:\n${stripped}`);
  // Sanity: planning content survived.
  assert.ok(/Planning Agent Response/.test(stripped));
  assert.ok(/Should we use foo\?/.test(stripped));
});

test('behaviour: end-to-end — after strip+append, `## User Reply to Questions` directly follows planning block', () => {
  // Build the exact failure shape from claude_harness.md:4928-4934.
  const planning =
    '## Planning Agent Response\n\n' +
    'Q list:\n1. Should we use X?\n2. Should we use Y?\n\n' +
    '*Model: claude-opus-4-7 | Effort: max*\n';
  const seeded = planning + '\n---\n\n## User Prompt\n\n';

  // Simulate the new ordering: strip first, then append reply block.
  let next = stripTrailingUserPrompt(seeded);
  next = next.replace(/\s*$/, '') + '\n\n---\n\n## User Reply to Questions\n\n1. yes\n\n2. no\n';

  // Assert: no redundant `## User Prompt` header sits between planning and reply.
  const between = next.slice(next.indexOf('Planning Agent Response'), next.indexOf('User Reply to Questions'));
  assert.ok(!/## User Prompt/.test(between),
    `expected no redundant '## User Prompt' header between planning and reply; got:\n${between}`);
});

if (_failed === 0) console.log('\nAll strip-trailing-user-prompt-before-reply tests passed.');
else console.error(`\n${_failed} test(s) failed.`);
