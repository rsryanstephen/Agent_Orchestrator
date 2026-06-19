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

// Extract the EXACT trailingPromptRe used inside fillEmptyPromptFromQueueOrInteractive.
function extractTrailingPromptRe() {
  const m = runAgentSrc.match(/const trailingPromptRe = (\/.+?\/);/);
  assert.ok(m, 'must find trailingPromptRe declaration');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

const trailingPromptRe = extractTrailingPromptRe();

// Mirror the source guard: regex always matches a trailing `## User Prompt`,
// so "empty" is decided by stripping HTML comments + whitespace from the body
// (group 2). Empty body -> dequeue pop fires; non-empty body -> pop is skipped.
function bodyStrippedOf(content) {
  const m = trailingPromptRe.exec(content);
  return (m ? (m[2] || '') : '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

test('empty trailing prompt DOES match (queue pop should fire)', () => {
  const content = '## Coding Agent Response\n\nprior body.\n\n---\n\n## User Prompt\n\n';
  assert.strictEqual(bodyStrippedOf(content).length, 0);
});

test('empty trailing prompt with only whitespace DOES match', () => {
  const content = '## Coding Agent Response\n\nprior.\n\n---\n\n## User Prompt\n   \n\t\n';
  assert.strictEqual(bodyStrippedOf(content).length, 0);
});

test('trailing prompt with user-typed body does NOT match (must not pop)', () => {
  const content = '## Coding Agent Response\n\nprior.\n\n---\n\n## User Prompt\n\nWhen the previous turn finished, it consumed the queued readme block.\n';
  assert.ok(bodyStrippedOf(content).length > 0,
    'a populated trailing prompt must NOT trigger queue-pop — would silently consume the head block');
});

test('trailing prompt body with a single non-whitespace char does NOT match', () => {
  const content = '## Coding Agent Response\n\nprior.\n\n---\n\n## User Prompt\n\nx';
  assert.ok(bodyStrippedOf(content).length > 0);
});

test('forensic trace fires at the dequeue callsite for post-mortem', () => {
  // The forensic-evidence trace must record both the pop outcome and the
  // body-head so a stray pop can be attributed in `.state/auto-resume.log`.
  assert.ok(/appendAutoResumeLog\(`dequeueFirstUnheld\[fillEmptyPrompt\]/.test(runAgentSrc),
    'fillEmptyPrompt callsite must trace the dequeue result');
});

test('one-shot retry path re-drains buffers and re-reads the queue', () => {
  // The reported regression: VS Code's async write lands after the initial
  // 400 ms flush, so the first dequeue sees an empty queue. A guarded one-shot
  // retry (sleep -> re-drain -> re-dequeue) is what recovers the late write.
  const idx = runAgentSrc.indexOf('async function fillEmptyPromptFromQueueOrInteractive');
  const fn = runAgentSrc.slice(idx, runAgentSrc.indexOf('\nfunction readMultilinePromptFromStdin', idx));
  assert.ok(/fill-prompt-retry-flush-ms/.test(fn), 'retry must read the retry-flush config key');
  assert.ok(/if \(retryMs > 0\)/.test(fn), 'retry must be gated on retryMs > 0 (0 = disabled)');
  // Order inside the retry block: sleep, then re-drain, then re-dequeue.
  const sleepIdx = fn.indexOf('sleepMs(retryMs)');
  const drainIdx = fn.indexOf('_drainFlushEditorBuffers()', sleepIdx);
  const requeIdx = fn.indexOf('retry = promptQueue.dequeueFirstUnheld', drainIdx);
  assert.ok(sleepIdx > 0 && drainIdx > sleepIdx && requeIdx > drainIdx,
    'retry must sleep, then re-drain editor buffers, then re-dequeue in that order');
  assert.ok(/dequeueFirstUnheld\[fillEmptyPrompt-retry\]/.test(fn),
    'retry outcome must be traced to auto-resume.log');
});

test('interactive-fallback reason reflects the latest dequeue result (not stale first attempt)', () => {
  // If the first dequeue was empty but the retry returned `all-held`, the printed
  // reason must say "all blocks held", not "queue is empty".
  const idx = runAgentSrc.indexOf('async function fillEmptyPromptFromQueueOrInteractive');
  const fn = runAgentSrc.slice(idx, runAgentSrc.indexOf('\nfunction readMultilinePromptFromStdin', idx));
  assert.ok(/const last = retry \|\| picked;/.test(fn),
    'reason must be computed from the latest non-null result (retry || picked)');
  assert.ok(/last && last\.warning === 'all-held'/.test(fn),
    'all-held check must read the latest result, not the stale first pick');
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
