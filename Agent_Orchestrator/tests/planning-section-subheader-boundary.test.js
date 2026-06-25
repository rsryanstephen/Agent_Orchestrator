#!/usr/bin/env node
'use strict';

// Regression tests for planning section extraction with sub-headers.
// Run: node Agent_Orchestrator/tests/planning-section-subheader-boundary.test.js
//
// Tests that extractLatestSection correctly handles agent sub-headers
// (## Plan, ## Verified Citations, etc.) as part of the response body
// and does not falsely truncate at them.

const assert = require('assert');
const { extractLatestSection } = require('../src/lib/fan-out');

// ANY_RESPONSE_HEADER pattern, mirrored from run-agent.js
const ANY_RESPONSE_HEADER = '(?:Planning|Coding|Assessment)\\s+Agent(?:\\s+\\d+)?\\s+Response(?:\\s*\\(Remediation(?:\\s+task-\\d+)?\\))?(?:\\s*\\(task-\\d+\\))?';

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── Include agent sub-headers in body ─────────────────────────────────────────
test('includes agent sub-headers (## Plan, ## Verified Citations) in extracted planning body', () => {
  const markdown = `## User Prompt
Add a feature.

## Planning Agent Response

- Task: implement feature

## Plan

- Step 1: read code
- Step 2: modify

## Verified Citations

- File A at line 10
- File B at line 20

## Coding Agent Response

Starting implementation.`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body, 'Should extract a non-null body');
  assert(body.includes('## Plan'), 'Body should include ## Plan sub-header');
  assert(body.includes('## Verified Citations'), 'Body should include ## Verified Citations sub-header');
  assert(body.includes('Step 1: read code'), 'Body should include plan steps');
  assert(!body.includes('## Coding Agent Response'), 'Body should NOT include next section');
});

// ── Stop at recognized boundary ───────────────────────────────────────────────
test('stops at the next recognized section boundary (## Coding Agent Response)', () => {
  const markdown = `## Planning Agent Response

My implementation plan.

## Parallel Tasks

- Task 1
- Task 2

## Coding Agent Response

Coding starts here.`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body, 'Should extract a non-null body');
  assert(body.includes('## Parallel Tasks'), 'Body should include ## Parallel Tasks sub-header');
  assert(!body.includes('## Coding Agent Response'), 'Body should stop before ## Coding Agent Response');
});

// ── Handle ## inside fenced code blocks ────────────────────────────────────────
test('handles ## inside fenced code blocks without falsely splitting', () => {
  const markdown = `## Planning Agent Response

Here is a code example:

\`\`\`
## SomeClass {
  public void doThing() {}
}
\`\`\`

## Plan

- Implement step

## Coding Agent Response

Coding.`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body, 'Should extract a non-null body');
  assert(body.includes('SomeClass'), 'Body should include code block content');
  assert(body.includes('## Plan'), 'Body should include ## Plan sub-header after code block');
  assert(!body.includes('## Coding Agent Response'), 'Body should stop at ## Coding Agent Response');
});

// ── Return null when header not found ─────────────────────────────────────────
test('returns null when header not found', () => {
  const markdown = `## User Prompt
Some prompt.

## Coding Agent Response
Code here.`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body === null, 'Should return null when header not found');
});

// ── Return null for empty body ───────────────────────────────────────────────
test('returns null when body is empty after trimming', () => {
  const markdown = `## Planning Agent Response

---`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body === null, 'Should return null for empty body');
});

// ── Trim trailing --- separator ──────────────────────────────────────────────
test('trims trailing --- separator and whitespace', () => {
  const markdown = `## Planning Agent Response

Real content here

---
`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body === 'Real content here', 'Should trim --- and whitespace');
});

// ── Match latest occurrence ──────────────────────────────────────────────────
test('matches latest occurrence when multiple headers exist', () => {
  const markdown = `## Planning Agent Response

First plan.

## Coding Agent Response

Code 1.

## Planning Agent Response

Second plan.

## Coding Agent Response

Code 2.`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body, 'Should extract the latest occurrence');
  assert(body.includes('Second plan'), 'Should return latest planning body');
  assert(!body.includes('First plan'), 'Should not include earlier planning body');
});

// ── Handle Remediation suffix ────────────────────────────────────────────────
test('handles Remediation suffix in boundary detection', () => {
  const markdown = `## Planning Agent Response

My plan.

## Coding Agent Response (Remediation)

Fix here.`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body, 'Should extract body');
  assert(body.includes('My plan'), 'Body should include plan text');
  assert(!body.includes('Fix here'), 'Body should stop before Remediation response');
});

// ── Handle multiple sub-headers in sequence ──────────────────────────────────
test('includes multiple consecutive sub-headers in body', () => {
  const markdown = `## Planning Agent Response

Plan introduction.

## Verified Citations

- Ref 1
- Ref 2

## Plan

- Step 1
- Step 2

## Parallel Tasks

- Task A
- Task B

## Coding Agent Response

Coding.`;

  const body = extractLatestSection(markdown, 'Planning Agent Response', ANY_RESPONSE_HEADER);
  assert(body, 'Should extract body');
  assert(body.includes('## Verified Citations'), 'Should include Verified Citations');
  assert(body.includes('## Plan'), 'Should include Plan');
  assert(body.includes('## Parallel Tasks'), 'Should include Parallel Tasks');
  assert(!body.includes('## Coding Agent Response'), 'Should not include Coding response');
});

// Summary
if (_failed > 0) {
  console.error(`\n${_failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
}
