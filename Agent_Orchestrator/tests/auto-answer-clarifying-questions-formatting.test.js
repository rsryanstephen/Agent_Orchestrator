#!/usr/bin/env node
'use strict';

/**
 * Regression tests for auto-answer-clarifying-questions formatting fixes in run-agent.js.
 * Run: node Agent_Orchestrator/tests/auto-answer-clarifying-questions-formatting.test.js
 *
 * Covers:
 *  (i)   `autoAnswerClarifyingQuestionsClarifyingQuestions` does NOT pass `systemPrompts.assessment` to `buildPayload`.
 *  (ii)  post-process strips `- 1. foo` -> `1. foo` and `*  2. bar` -> `2. bar`.
 *  (iii) text without leading bullets unchanged.
 *  (iv)  `countAnswers` sees cleaned numbers after strip.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Extract the autoAnswerClarifyingQuestionsClarifyingQuestions function body — brace-balanced scan.
function extractFnBody(src, fnName) {
  const idx = src.indexOf(`async function ${fnName}`);
  if (idx < 0) throw new Error(`fn ${fnName} not found`);
  // Walk to the param list's matching `)`, then find the first `{` after — that's the body.
  let i = src.indexOf('(', idx);
  let pdepth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { i++; break; } }
  }
  const braceStart = src.indexOf('{', i);
  let depth = 0;
  for (let j = braceStart; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(idx, j + 1); }
  }
  throw new Error('unbalanced braces');
}

const fnBody = extractFnBody(runAgentSrc, 'autoAnswerClarifyingQuestionsClarifyingQuestions');

test('(i) autoAnswerClarifyingQuestionsClarifyingQuestions does NOT pass systemPrompts.assessment to buildPayload', () => {
  // Find every buildPayload(...) call inside the fn and assert systemPrompts.assessment is not a top-level arg.
  const calls = fnBody.match(/buildPayload\([\s\S]*?\)/g) || [];
  assert.ok(calls.length > 0, 'expected at least one buildPayload call');
  for (const c of calls) {
    assert.ok(!/systemPrompts\.assessment/.test(c), `buildPayload still references systemPrompts.assessment:\n${c}`);
  }
});

test('(i.b) autoAnswerClarifyingQuestionsClarifyingQuestions uses dedicated minimal system prompt', () => {
  assert.ok(
    /You answer numbered clarifying questions\./.test(fnBody),
    'expected dedicated auto-answer-clarifying-questions system prompt string in fn body'
  );
  assert.ok(
    /no caveman compression/i.test(fnBody),
    'expected "no caveman compression" instruction in auto-answer-clarifying-questions system prompt'
  );
});

// Replicate the post-process helper inline for (ii)/(iii)/(iv).
// Must mirror the implementation in run-agent.js — keep regex in sync.
function stripLeadingBullets(s) {
  return (s || '').split('\n').map(line => line.replace(/^(\s*)[-*+]\s+(\d+\.\s)/, '$1$2')).join('\n');
}
function countAnswers(text) {
  const seen = new Set();
  const re = /^\s*(\d+)\.\s+/gm;
  let m;
  while ((m = re.exec(text)) !== null) seen.add(Number(m[1]));
  return seen.size;
}

test('(ii.a) strips `- 1. foo` -> `1. foo`', () => {
  assert.strictEqual(stripLeadingBullets('- 1. foo'), '1. foo');
});

test('(ii.b) strips `*  2. bar` -> `2. bar`', () => {
  assert.strictEqual(stripLeadingBullets('*  2. bar'), '2. bar');
});

test('(ii.c) strips `+ 3. baz` and preserves indentation', () => {
  assert.strictEqual(stripLeadingBullets('  + 3. baz'), '  3. baz');
});

test('(ii.d) strips bullets across multi-line numbered list', () => {
  const input = '- 1. foo\n\n- 2. bar\n\n- 3. baz';
  const expected = '1. foo\n\n2. bar\n\n3. baz';
  assert.strictEqual(stripLeadingBullets(input), expected);
});

test('(iii) text without leading bullets unchanged', () => {
  const input = '1. already clean\n\n2. also clean\n\nsome prose with - dash mid-line';
  assert.strictEqual(stripLeadingBullets(input), input);
});

test('(iii.b) bullets NOT followed by numbered item unchanged', () => {
  const input = '- regular bullet\n* another bullet';
  assert.strictEqual(stripLeadingBullets(input), input);
});

test('(iv) countAnswers sees cleaned numbers after strip', () => {
  const dirty = '- 1. foo\n\n* 2. bar\n\n+ 3. baz';
  // countAnswers regex `^\s*\d+\.` does NOT match `- 1.` because `-` is non-whitespace -> 0 hits.
  assert.strictEqual(countAnswers(dirty), 0, 'dirty input with leading bullets is NOT counted — motivates the cleanup');
  const cleaned = stripLeadingBullets(dirty);
  assert.strictEqual(countAnswers(cleaned), 3, 'countAnswers sees 3 distinct numbers post-clean');
  assert.strictEqual(cleaned, '1. foo\n\n2. bar\n\n3. baz');
});

test('(iv.b) source applies normalizeAnswerText before the merge-count retry check', () => {
  // Confirm order: text = normalizeAnswerText(...) happens before the size check used in retry guard.
  // (Fn was renamed from `stripLeadingBullets` -> `normalizeAnswerText` to reflect broader normalization.)
  const stripIdx = fnBody.indexOf('text = normalizeAnswerText(text)');
  const mergeIdx = fnBody.indexOf('merged.size < expectedCount');
  assert.ok(stripIdx > -1, 'expected normalizeAnswerText(text) call in fn');
  assert.ok(mergeIdx > -1, 'expected `merged.size < expectedCount` retry-guard in fn');
  assert.ok(stripIdx < mergeIdx, 'normalizeAnswerText must run before merge-count retry guard');
});

// ── Regression: Issue 1 — partial-answer escalation ladder ────────────────────
test('(v) autoAnswerClarifyingQuestionsClarifyingQuestions defines parseAnswersByIndex helper for merging', () => {
  assert.ok(/parseAnswersByIndex/.test(fnBody),
    'fn must define `parseAnswersByIndex` to extract answers keyed by question number for merging');
});

test('(v.b) autoAnswerClarifyingQuestionsClarifyingQuestions defines getAnsweredIndices helper', () => {
  assert.ok(/getAnsweredIndices/.test(fnBody),
    'fn must define `getAnsweredIndices` to compute the set of answered question numbers');
});

test('(vi) on still-short retry, fn issues a single re-prompt listing ONLY missing question numbers', () => {
  assert.ok(/callOnceForMissing/.test(fnBody),
    'fn must define `callOnceForMissing(missingIndices)` for the second-tier re-prompt');
  assert.ok(/Only answer remaining questions/i.test(fnBody),
    'fn must include "Only answer remaining questions: N, M, ..." instruction in the re-prompt');
  // Order: only-missing re-prompt comes BEFORE per-question fan-out.
  const reIdx = fnBody.indexOf('Only answer remaining questions');
  const fanIdx = fnBody.indexOf('per-question fan-out');
  assert.ok(reIdx > -1 && fanIdx > -1 && reIdx < fanIdx,
    'single re-prompt for missing questions must occur BEFORE per-question fan-out escalation');
});

test('(vii) per-question fan-out is the LAST-resort escalation, gated on still-missing answers', () => {
  assert.ok(/Escalating to per-question fan-out/i.test(fnBody),
    'fn must log when escalating to per-question fan-out');
  assert.ok(/Promise\.all\(stillMissing\.map/.test(fnBody),
    'per-question fan-out must dispatch one callOnce per remaining missing index in parallel');
});

test('(viii) merging dedupes by question index (no double-counted answers)', () => {
  // parseAnswersByIndex uses Map keyed by question number — first occurrence wins.
  // Behavioural replica: feed text that repeats Q1 — only first value retained.
  function parseAnswersByIndex(text, expectedCount) {
    const map = new Map();
    const re = /^\s*(\d+)\.\s+([\s\S]*?)(?=^\s*\d+\.\s+|(?![\s\S]))/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (n >= 1 && n <= expectedCount && !map.has(n)) {
        map.set(n, m[2].trim());
      }
    }
    return map;
  }
  const text = '1. first\n\n2. second\n\n1. duplicate first should be ignored';
  const map = parseAnswersByIndex(text, 3);
  assert.strictEqual(map.get(1), 'first', 'first occurrence of Q1 must win — no double-count');
  assert.strictEqual(map.get(2), 'second');
  assert.strictEqual(map.has(3), false);
});

// ── Regression: multi-paragraph answers must not be truncated at blank lines ──
test('(x) parseAnswersByIndex captures multi-paragraph answers fully (no truncation at blank lines)', () => {
  // Source-level: anchor must use `(?![\s\S])` (true end-of-string), NOT `\s*$`
  // (multiline end-of-line). With `\s*$` + /m, the first blank line inside an
  // answer body terminates the capture early — long answers got truncated.
  assert.ok(/\(\?\!\[\\s\\S\]\)/.test(fnBody),
    'parseAnswersByIndex regex MUST anchor with `(?![\\s\\S])` (true end-of-string), not `\\s*$` (multiline EOL)');
  assert.ok(!/\(\?\=\^\\s\*\\d\+\\\.\\s\+\|\\s\*\$\)/.test(fnBody),
    'old multiline-EOL anchor `\\s*$` must be gone — it truncated multi-paragraph answers at the first blank line');

  // Behavioural: feed a multi-paragraph Q1 answer and assert the trailing paragraph is kept.
  function parseAnswersByIndex(text, expectedCount) {
    const map = new Map();
    const re = /^\s*(\d+)\.\s+([\s\S]*?)(?=^\s*\d+\.\s+|(?![\s\S]))/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (n >= 1 && n <= expectedCount && !map.has(n)) {
        map.set(n, m[2].trim());
      }
    }
    return map;
  }
  const text = '1. First paragraph of answer one.\n\nSecond paragraph that must survive.\n\nThird paragraph also kept.';
  const map = parseAnswersByIndex(text, 1);
  assert.match(map.get(1) || '', /Second paragraph that must survive/,
    'multi-paragraph answer must NOT be truncated at the first blank line');
  assert.match(map.get(1) || '', /Third paragraph also kept/,
    'last paragraph must survive — anchor must bind to end-of-string, not end-of-line');
});

test('(ix) merging keeps a Q answered in tier-1 even when tier-2/3 re-prompts also reply for it', () => {
  // Source-level check: the second re-prompt merge loop must guard `!merged.has(n)`.
  assert.ok(/if \(!merged\.has\(n\) && missing\.includes\(n\)\) merged\.set\(n, ans\)/.test(fnBody),
    'second-tier merge must skip indices already answered (no overwrite)');
  assert.ok(/if \(ans && !merged\.has\(n\)\) merged\.set\(n, ans\)/.test(fnBody),
    'per-question fan-out merge must skip indices already answered (no overwrite)');
});

if (_failed === 0) console.log('\nAll auto-answer-clarifying-questions-formatting tests passed.');
else console.error(`\n${_failed} test(s) failed.`);
