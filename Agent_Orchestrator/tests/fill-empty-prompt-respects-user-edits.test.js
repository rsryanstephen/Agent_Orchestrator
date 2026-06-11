#!/usr/bin/env node
'use strict';

/**
 * Regression: `fillEmptyPromptFromQueueOrInteractive` must only pop a queued block
 * when the trailing `## User Prompt` is genuinely EMPTY (header + whitespace-only
 * to EOF). If the user typed a body — even with leading/trailing whitespace — the
 * popped block must NOT replace it; otherwise queued prompts get silently consumed.
 *
 * Source-level + regex behaviour test (the function is async + tied to module-level
 * state, so we lift the trailing-empty regex out of the source and exercise it).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Extract the EXACT trailingEmptyRe used inside fillEmptyPromptFromQueueOrInteractive.
function extractTrailingEmptyRe() {
  const m = runAgentSrc.match(/const trailingEmptyRe = (\/.+?\/);/);
  assert.ok(m, 'must find trailingEmptyRe declaration');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

const trailingEmptyRe = extractTrailingEmptyRe();

test('empty trailing prompt DOES match (queue pop should fire)', () => {
  const content = '## Coding Agent Response\n\nprior body.\n\n---\n\n## User Prompt\n\n';
  assert.ok(trailingEmptyRe.test(content));
});

test('empty trailing prompt with only whitespace DOES match', () => {
  const content = '## Coding Agent Response\n\nprior.\n\n---\n\n## User Prompt\n   \n\t\n';
  assert.ok(trailingEmptyRe.test(content));
});

test('trailing prompt with user-typed body does NOT match (must not pop)', () => {
  const content = '## Coding Agent Response\n\nprior.\n\n---\n\n## User Prompt\n\nWhen the previous turn finished, it consumed the queued readme block.\n';
  assert.ok(!trailingEmptyRe.test(content),
    'a populated trailing prompt must NOT trigger queue-pop — would silently consume the head block');
});

test('trailing prompt body with a single non-whitespace char does NOT match', () => {
  const content = '## Coding Agent Response\n\nprior.\n\n---\n\n## User Prompt\n\nx';
  assert.ok(!trailingEmptyRe.test(content));
});

test('forensic trace fires at the dequeue callsite for post-mortem', () => {
  // The forensic-evidence trace must record both the pop outcome and the
  // body-head so a stray pop can be attributed in `.state/auto-resume.log`.
  assert.ok(/appendAutoResumeLog\(`dequeueFirstUnheld\[fillEmptyPrompt\]/.test(runAgentSrc),
    'fillEmptyPrompt callsite must trace the dequeue result');
});

test('fillEmptyPrompt callsite remains in the dispatch entry pre-strip ordering', () => {
  // The function comment promises it runs ONCE at dispatch entry before
  // stripTrailingUserPrompt — that ordering invariant is what protects against
  // the alternate-hypothesis race (user edits arrive after the queue pop).
  const idx = runAgentSrc.indexOf('async function fillEmptyPromptFromQueueOrInteractive');
  assert.ok(idx > 0);
  const header = runAgentSrc.slice(idx - 800, idx);
  assert.ok(/runs once at\s*\n\/\/ dispatch entry before `stripTrailingUserPrompt`/.test(header),
    'docstring must still pin the dispatch-entry ordering invariant');
});
