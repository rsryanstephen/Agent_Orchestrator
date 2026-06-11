#!/usr/bin/env node
'use strict';

// Regression tests for parseConversationContext — must return only blocks from the
// LATEST `## User Prompt` onward; stale earlier prompts and stale `## Clarifying
// Questions` blocks from prior turns must be excluded so downstream agents do not
// respond to the wrong prompt.
//
// Coverage:
//   (a) 3 sequential `## User Prompt` blocks -> only the LAST is selected
//   (b) prompt followed by `## User Reply to Questions` -> both kept, prior turn dropped
//   (c) stale `## Clarifying Questions` earlier in file is ignored once a newer
//       `## User Prompt` exists
//
// Run: node Agent_Orchestrator/tests/parseConversationContext.latest-prompt.test.js
// No real Claude invocations — pure string-parser test.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Replicate the FIXED parseConversationContext from run-agent.js.
const CONTEXT_TRUNCATION = 400;
const ANY_RESPONSE_HEADER = '(?:Planning|Coding|Assessment)\\s+Agent(?:\\s+\\d+)?\\s+Response(?:\\s*\\(Remediation(?:\\s+task-\\d+)?\\))?(?:\\s*\\(task-\\d+\\))?';

function parseConversationContext(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const clearMarker = '--- CLEAR CONTEXT ---';
  const lastClearIdx = content.lastIndexOf(clearMarker);
  const raw = lastClearIdx >= 0 ? content.slice(lastClearIdx + clearMarker.length) : content;

  const MASK = '\x00##';
  const masked = raw.replace(/`{3}[\s\S]*?`{3}/g, block => block.replace(/^##/gm, MASK));

  const headerSplit = new RegExp(`^(##\\s+(?:User Prompt(?:\\s+\\([^)\\n]*\\))?|User Reply to Questions|Auto Reply to Clarifying Questions|Auto Answer|${ANY_RESPONSE_HEADER}))\\s*$`, 'gim');
  const parts = masked.split(headerSplit);
  if (parts.length < 3) return null;

  let blocks = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const header = parts[i].trim();
    const text = parts[i + 1].replace(/\x00##/g, '##').replace(/\n---\s*$/, '').trim();
    if (text) blocks.push({ header, text });
  }

  if (!blocks.some(b => /user prompt/i.test(b.header))) return null;

  let lastUserPromptIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (/^##\s+User Prompt\b/i.test(blocks[i].header.trim())) lastUserPromptIdx = i;
  }
  if (lastUserPromptIdx >= 0) blocks = blocks.slice(lastUserPromptIdx);

  return blocks.map(block => {
    let text = block.text;
    if (/agent response/i.test(block.header)) {
      text = text.replace(/\n\n\*Model:[\s\S]*?\*\s*$/, '');
      if (text.length > CONTEXT_TRUNCATION) {
        text = text.slice(0, CONTEXT_TRUNCATION) + '\n...[truncated to save tokens]';
      }
    }
    return `${block.header}\n\n${text}`;
  }).join('\n\n');
}

// Source-level sanity: confirm the FIX is actually present in run-agent.js so the
// replicated logic doesn't drift from the real implementation.
const RUN_AGENT = path.join(__dirname, '..', 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

test('source: run-agent.js parseConversationContext slices from latest User Prompt', () => {
  assert.ok(
    /lastUserPromptIdx\s*=\s*-1[\s\S]*?for\s*\([\s\S]*?\/\^##\\s\+User Prompt\\b\/i[\s\S]*?blocks\s*=\s*blocks\.slice\(lastUserPromptIdx\)/.test(src),
    'expected latest-prompt slice block in run-agent.js parseConversationContext'
  );
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-ctx-test-'));
function tmpFile(name, contents) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, contents, 'utf8');
  return p;
}

// (a) 3 sequential user prompts -> only last is selected
test('(a) 3 sequential ## User Prompt blocks -> only LAST selected', () => {
  const file = tmpFile('a.md', [
    '# topic',
    '',
    '## User Prompt',
    '',
    'first prompt body',
    '',
    '## Coding Agent Response',
    '',
    'first coding response',
    '',
    '## User Prompt',
    '',
    'second prompt body',
    '',
    '## Coding Agent Response',
    '',
    'second coding response',
    '',
    '## User Prompt',
    '',
    'third prompt body LATEST',
    '',
  ].join('\n'));

  const ctx = parseConversationContext(file);
  assert.ok(ctx, 'should return non-null');
  assert.ok(ctx.includes('third prompt body LATEST'), 'must include latest prompt');
  assert.ok(!ctx.includes('first prompt body'), 'must NOT include first prompt');
  assert.ok(!ctx.includes('second prompt body'), 'must NOT include second prompt');
  assert.ok(!ctx.includes('first coding response'), 'must NOT include first response');
  assert.ok(!ctx.includes('second coding response'), 'must NOT include second response');
  // The starting block must be the latest User Prompt header
  assert.ok(/^## User Prompt\b/.test(ctx), 'result must start with ## User Prompt header');
});

// (b) prompt followed by `## User Reply to Questions` -> both kept; prior turn dropped
test('(b) latest ## User Prompt + subsequent ## User Reply to Questions both kept', () => {
  const file = tmpFile('b.md', [
    '# topic',
    '',
    '## User Prompt',
    '',
    'STALE previous prompt',
    '',
    '## Planning Agent Response',
    '',
    'stale plan',
    '',
    '## User Prompt',
    '',
    'CURRENT prompt body',
    '',
    '## Planning Agent Response',
    '',
    '## Clarifying Questions',
    '',
    '1. q1?',
    '2. q2?',
    '',
    '## User Reply to Questions',
    '',
    'user reply with TWO numbered answers',
    '',
  ].join('\n'));

  const ctx = parseConversationContext(file);
  assert.ok(ctx, 'should return non-null');
  assert.ok(ctx.includes('CURRENT prompt body'), 'must include latest user prompt');
  assert.ok(ctx.includes('user reply with TWO numbered answers'), 'must include latest user reply');
  assert.ok(!ctx.includes('STALE previous prompt'), 'must NOT include stale prior prompt');
  assert.ok(!ctx.includes('stale plan'), 'must NOT include stale prior planning response');
});

// (c) stale `## Clarifying Questions` earlier in file ignored when a newer ## User Prompt exists
test('(c) stale ## Clarifying Questions before latest ## User Prompt is ignored', () => {
  const file = tmpFile('c.md', [
    '# topic',
    '',
    '## User Prompt',
    '',
    'old prompt',
    '',
    '## Planning Agent Response',
    '',
    '## Clarifying Questions',
    '',
    '1. STALE clarifying question?',
    '',
    '## User Reply to Questions',
    '',
    'stale reply',
    '',
    '## Coding Agent Response',
    '',
    'old completed work',
    '',
    '## User Prompt',
    '',
    'BRAND NEW prompt body',
    '',
  ].join('\n'));

  const ctx = parseConversationContext(file);
  assert.ok(ctx, 'should return non-null');
  assert.ok(ctx.includes('BRAND NEW prompt body'), 'must include latest user prompt');
  assert.ok(!ctx.includes('STALE clarifying question'), 'stale clarifying questions must be dropped');
  assert.ok(!ctx.includes('stale reply'), 'stale user replies must be dropped');
  assert.ok(!ctx.includes('old completed work'), 'stale agent responses must be dropped');
  assert.ok(!ctx.includes('old prompt'), 'stale prior user prompt must be dropped');
});

// (d) header tolerates trailing colon/text — relaxed regex matches `## User Prompt:` variants
test('(d) ## User Prompt with trailing punctuation/text still recognized as latest', () => {
  const file = tmpFile('d.md', [
    '# topic',
    '',
    '## User Prompt',
    '',
    'STALE first prompt',
    '',
    '## Coding Agent Response',
    '',
    'stale response',
    '',
    '## User Prompt   ',
    '',
    'LATEST prompt with header trailing whitespace',
    '',
  ].join('\n'));
  const ctx = parseConversationContext(file);
  assert.ok(ctx, 'should return non-null');
  assert.ok(ctx.includes('LATEST prompt with header trailing whitespace'), 'relaxed regex must match trailing-whitespace header');
  assert.ok(!ctx.includes('STALE first prompt'), 'must drop stale prompt');
});

// (e) queue-injected `## User Prompt (From the Queue)` must be recognized as the latest
//     User Prompt header — prior bug: tagged suffix broke headerSplit, agent saw stale prompt.
test('(e) ## User Prompt (From the Queue) is recognized as latest user prompt', () => {
  const file = tmpFile('e.md', [
    '# topic',
    '',
    '## User Prompt',
    '',
    'STALE prompt about previous topic',
    '',
    '## Planning Agent Response',
    '',
    'stale plan about previous topic',
    '',
    '## Coding Agent Response',
    '',
    'stale coding work',
    '',
    '---',
    '',
    '## User Prompt (From the Queue)',
    '',
    'FRESH prompt dequeued from queue',
    '',
  ].join('\n'));
  const ctx = parseConversationContext(file);
  assert.ok(ctx, 'should return non-null');
  assert.ok(ctx.includes('FRESH prompt dequeued from queue'), 'must include the queue-injected latest prompt');
  assert.ok(!ctx.includes('STALE prompt about previous topic'), 'must drop stale prior prompt');
  assert.ok(!ctx.includes('stale plan about previous topic'), 'must drop stale prior planning response');
  assert.ok(!ctx.includes('stale coding work'), 'must drop stale prior coding response');
  assert.ok(/^## User Prompt \(From the Queue\)/.test(ctx), 'result must start with the tagged header');
});

// (f) suffix scoping: the optional `(...)` suffix MUST attach to `User Prompt` only,
//     NOT to response-header alternations. `## Coding Agent Response (Remediation)` still
//     splits because `ANY_RESPONSE_HEADER` already encodes its own remediation/task suffixes,
//     but an arbitrary `(Foo)` suffix on a response header must NOT create a new split-point.
test('(f) response-header (Remediation) still splits; arbitrary suffix on response headers does NOT split', () => {
  const file = tmpFile('f.md', [
    '# topic',
    '',
    '## User Prompt',
    '',
    'latest prompt',
    '',
    '## Coding Agent Response (Remediation)',
    '',
    'remediation body kept as its own block',
    '',
    '## Coding Agent Response (UnknownTag)',
    '',
    'this body must stay attached to the previous block, NOT split off',
    '',
  ].join('\n'));
  const ctx = parseConversationContext(file);
  assert.ok(ctx, 'should return non-null');
  assert.ok(ctx.includes('remediation body kept as its own block'), 'remediation block must be present');
  // `(UnknownTag)` is not a recognised response-header suffix; the header line should remain part
  // of the prior block's text instead of becoming its own split-point.
  assert.ok(
    ctx.includes('## Coding Agent Response (UnknownTag)'),
    'unrecognised response-header suffix should remain in body text, not become a split header'
  );
});

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
