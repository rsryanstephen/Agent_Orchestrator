#!/usr/bin/env node
'use strict';

// Regression test: lastAgentResponseContainsClarifyingQuestions must capture
// ALL numbered questions, not just Q1. Root cause was `$` in `/im` regex —
// multiline `$` fires at end of each line so non-greedy `[\s\S]*?` stopped
// after Q1. Fix removes `m` flag (making `$` mean end-of-string) and
// replaces multiline `^` with `(?:^|\r?\n)`.

const assert = require('assert');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Inline the FIXED regex so this test is self-contained and guards against
// future regression if the regex is changed back.
function extractClarifyingQuestionsText(body) {
  const qm = body.match(/(?:^|\r?\n)##+[ \t]*Clarifying Questions[ \t]*\r?\n([\s\S]*?)(?=\r?\n##+\s|$)/i);
  return qm ? qm[1].trim() : null;
}

// Also verify the source-level regex in run-agent.js matches the fixed form.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'run-agent.js'), 'utf8');

test('(A) source regex uses no `m` flag after Clarifying Questions qm match', () => {
  // Must NOT have /im — only /i allowed (no multiline $ matching)
  const match = src.match(/const qm = body\.match\(([^;]+)\)/);
  assert.ok(match, 'qm assignment must exist in source');
  const regexLiteral = match[1].trim();
  // The flags at the end of the regex literal: should be /i not /im
  assert.ok(!/\/im\s*;/.test(regexLiteral + ';'), 'regex must NOT use /im — m flag causes $ to match end-of-line, dropping Q2+');
  assert.ok(/\/i\s*;/.test(regexLiteral + ';'), 'regex must use /i flag');
});

test('(B) 5-question block: all 5 questions captured', () => {
  const body =
    '\n- Planning complete.\n\n' +
    '## Clarifying Questions\n\n' +
    '1. First question here with multiple words?\n\n' +
    '2. Second question, also long?\n\n' +
    '3. Third question with sub-options (a) or (b)?\n\n' +
    '4. Fourth question?\n\n' +
    '5. Fifth and final question?\n\n' +
    '*Model: claude-opus-4-7*\n\n' +
    '---\n\n';
  const captured = extractClarifyingQuestionsText(body);
  assert.ok(captured, 'must capture something');
  for (let n = 1; n <= 5; n++) {
    assert.ok(captured.includes(`${n}.`), `captured text must include Q${n} — only got: ${captured.slice(0, 200)}`);
  }
});

test('(C) 2-question block: both questions captured (regression for Q1-only bug)', () => {
  const body =
    '## Clarifying Questions\n\n' +
    '1. Do you want option A or B?\n\n' +
    '2. Should this be backwards compatible?\n';
  const captured = extractClarifyingQuestionsText(body);
  assert.ok(captured, 'must capture something');
  assert.ok(/1\./.test(captured), 'Q1 must be present');
  assert.ok(/2\./.test(captured), 'Q2 must be present — previously dropped due to m-flag $ bug');
});

test('(D) multi-paragraph question: full body captured', () => {
  const body =
    '## Clarifying Questions\n\n' +
    '1. Can you paste the exact contents of the file including:\n' +
    '   - the `(hold)` marker\n' +
    '   - surrounding `---` dividers\n\n' +
    '2. Where was the `(hold)` placed?\n';
  const captured = extractClarifyingQuestionsText(body);
  assert.ok(captured, 'must capture something');
  assert.ok(/hold.*marker/.test(captured), 'multi-line Q1 body must survive');
  assert.ok(/2\./.test(captured), 'Q2 must still be present after multi-line Q1');
});

test('(E) stops at next ## section header, does not bleed into next block', () => {
  const body =
    '## Clarifying Questions\n\n' +
    '1. Q one?\n\n' +
    '2. Q two?\n\n' +
    '## Some Other Section\n\n' +
    'Content that must NOT appear in capture.\n';
  const captured = extractClarifyingQuestionsText(body);
  assert.ok(captured, 'must capture something');
  assert.ok(!captured.includes('Some Other Section'), 'must stop at next ## header');
  assert.ok(!captured.includes('Content that must NOT'), 'must not bleed past ## header');
});

test('(F) CRLF line endings: all questions still captured', () => {
  const body =
    '## Clarifying Questions\r\n\r\n' +
    '1. Question with CRLF endings?\r\n\r\n' +
    '2. Second question?\r\n';
  const captured = extractClarifyingQuestionsText(body);
  assert.ok(captured, 'must capture something with CRLF');
  assert.ok(/1\./.test(captured), 'Q1 must be present with CRLF');
  assert.ok(/2\./.test(captured), 'Q2 must be present with CRLF');
});

if (_failed === 0) console.log('\nAll clarifying-questions-all-captured tests passed.');
else console.error(`\n${_failed} test(s) failed.`);
