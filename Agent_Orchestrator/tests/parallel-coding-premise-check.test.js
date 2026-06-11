'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Build subPayload the same way run-agent.js does (extracted for isolation).
function buildSubPayload(index, total, task, fullContext) {
  return (
`You are Coding Agent ${index + 1} of ${total}. Other agents run in parallel — only changes you make are yours. Focus ONLY on the subtask assigned to you below. Do not duplicate work that belongs to a sibling subtask.

## Premise Check (Mandatory)
Before writing any code, re-verify every factual claim in your subtask against the actual source files (read the cited file and line range). If the cited evidence does not exist, has already been fixed, or does not support the diagnosis, do NOT write code. Instead emit a section headed exactly:

## Premise Rejected
…with the specific counter-evidence (file path, line number, what you actually found). Stop there — do not proceed to implementation.

Only proceed to implementation if every cited premise is confirmed by the source.

## Your Subtask
${task}

## Full Original Prompt Context (for reference)
${fullContext}`
  );
}

describe('parallel coding subPayload — premise check block', () => {
  it('premise-check block appears before ## Your Subtask', () => {
    const payload = buildSubPayload(0, 3, 'Fix the bug in foo.js:42', 'some context');
    const premiseIdx = payload.indexOf('## Premise Check (Mandatory)');
    const subtaskIdx = payload.indexOf('## Your Subtask');
    assert.ok(premiseIdx !== -1, '## Premise Check (Mandatory) header missing');
    assert.ok(subtaskIdx !== -1, '## Your Subtask header missing');
    assert.ok(premiseIdx < subtaskIdx, '## Premise Check must precede ## Your Subtask');
  });

  it('premise-check block contains ## Premise Rejected instruction', () => {
    const payload = buildSubPayload(1, 3, 'Some subtask', '');
    assert.ok(payload.includes('## Premise Rejected'), '## Premise Rejected instruction missing');
  });

  it('premise-check instructs agent to stop if premise fails', () => {
    const payload = buildSubPayload(0, 1, 'task', '');
    assert.ok(payload.includes('do NOT write code'), 'must instruct agent not to write code on failed premise');
    assert.ok(payload.includes('Stop there'), 'must instruct agent to stop after emitting Premise Rejected');
  });

  it('task content preserved under ## Your Subtask', () => {
    const task = 'Unique task content abc123';
    const payload = buildSubPayload(0, 2, task, '');
    const subtaskIdx = payload.indexOf('## Your Subtask');
    const afterSubtask = payload.slice(subtaskIdx);
    assert.ok(afterSubtask.includes(task), 'task content must appear after ## Your Subtask');
  });

  it('full context preserved after ## Full Original Prompt Context', () => {
    const ctx = 'FULL_CTX_MARKER_xyz';
    const payload = buildSubPayload(2, 3, 'task', ctx);
    const ctxIdx = payload.indexOf('## Full Original Prompt Context (for reference)');
    assert.ok(ctxIdx !== -1, '## Full Original Prompt Context header missing');
    assert.ok(payload.slice(ctxIdx).includes(ctx), 'full context must appear after its header');
  });
});
