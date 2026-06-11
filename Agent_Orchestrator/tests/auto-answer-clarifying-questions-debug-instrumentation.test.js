#!/usr/bin/env node
'use strict';

/**
 * Regression tests for the five debug-instrumentation hardening items added to
 * run-agent.js so a future silent collapse of the clarifying-question pipeline
 * is actually inspectable from .state/auto-answer-clarifying-questions-debug.log.
 *
 * Run: node Agent_Orchestrator/tests/auto-answer-clarifying-questions-debug-instrumentation.test.js
 *
 * Source-level guarantees verified (one per plan bullet):
 *   (1) extractNumberedQuestions logs every raw regex hit AND a final entry
 *       with the FULL untruncated questionsText.
 *   (2) callOnce / callOnceForMissing payload entries are NO LONGER 2 KB-
 *       truncated, and a new `auto-answer-clarifying-questions-raw-response` entry logs the FULL
 *       untouched runClaude text BEFORE normalizeAnswerText. A separate
 *       `auto-answer-clarifying-questions-normalized` entry logs the post-normalization text.
 *   (3) parseAnswersByIndex emits a debug entry per call with every regex
 *       match (n, preview, kept/dropped) so duplicate or out-of-range numbers
 *       are visible.
 *   (4) lastAgentResponseContainsClarifyingQuestions emits a debug entry with
 *       the exact `tail` / `body` / matched `qm[1]` slices it fed into
 *       extractNumberedQuestions.
 *   (5) The pre-append branch logs the final `merged` Map (n -> first 120
 *       chars), the rendered body, and the appendToFile target header.
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

function extractFnBody(src, fnName) {
  const idx = src.indexOf(`async function ${fnName}`) >= 0
    ? src.indexOf(`async function ${fnName}`)
    : src.indexOf(`function ${fnName}`);
  if (idx < 0) throw new Error(`fn ${fnName} not found`);
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

const extractFn = extractFnBody(runAgentSrc, 'extractNumberedQuestions');
const lastClarFn = extractFnBody(runAgentSrc, 'lastAgentResponseContainsClarifyingQuestions');
const autoFnBody = extractFnBody(runAgentSrc, 'autoAnswerClarifyingQuestionsClarifyingQuestions');

// ── (1) extractNumberedQuestions raw-hit logging ────────────────────────────
test('(1.a) extractNumberedQuestions logs one debug entry per regex hit', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]extractNumberedQuestions-hit['"][\s\S]*?\}\)/.test(extractFn),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"extractNumberedQuestions-hit"...}) inside extractNumberedQuestions');
});

test('(1.b) extractNumberedQuestions logs the FULL raw questionsText (untruncated)', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]extractNumberedQuestions-raw['"][\s\S]*?\}\)/.test(extractFn),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"extractNumberedQuestions-raw"...}) inside extractNumberedQuestions');
  // Must pass `questionsText` itself (no .slice / no truncation).
  assert.ok(/text:\s*questionsText\s*\|\|\s*['"]['"]/.test(extractFn),
    'extractNumberedQuestions-raw must log `text: questionsText || ""` — full untruncated text');
});

// ── (2) untruncated payload + raw runClaude response logging ────────────────
test('(2.a) auto-answer-clarifying-questions-payload entry no longer slices to 2 KB', () => {
  // Locate the auto-answer-clarifying-questions-payload entry block and confirm no .slice(0, 2048) inside it.
  const block = autoFnBody.match(/appendAutoAnswerClarifyingQuestionsDebug\(\{[^}]*?label:\s*['"]auto-answer-clarifying-questions-payload['"][\s\S]*?\}\)/);
  assert.ok(block, 'auto-answer-clarifying-questions-payload entry must exist');
  assert.ok(!/\.slice\(0,\s*2048\)/.test(block[0]),
    'auto-answer-clarifying-questions-payload must NOT truncate payload to 2 KB anymore');
});

test('(2.b) auto-answer-clarifying-questions-missing-payload entry no longer slices to 2 KB', () => {
  const block = autoFnBody.match(/appendAutoAnswerClarifyingQuestionsDebug\(\{[^}]*?label:\s*['"]auto-answer-clarifying-questions-missing-payload['"][\s\S]*?\}\)/);
  assert.ok(block, 'auto-answer-clarifying-questions-missing-payload entry must exist');
  assert.ok(!/\.slice\(0,\s*2048\)/.test(block[0]),
    'auto-answer-clarifying-questions-missing-payload must NOT truncate payload to 2 KB anymore');
});

test('(2.c) auto-answer-clarifying-questions-raw-response label captures FULL untouched runClaude text BEFORE normalizeAnswerText', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions-raw-response['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions-raw-response"...}) right after runClaude inside callOnce');
});

test('(2.d) auto-answer-clarifying-questions-missing-raw-response label captures FULL untouched runClaude text from callOnceForMissing', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions-missing-raw-response['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions-missing-raw-response"...}) right after runClaude inside callOnceForMissing');
});

test('(2.e) auto-answer-clarifying-questions-normalized label captures text AFTER normalizeAnswerText', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions-normalized['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions-normalized"...}) immediately after `text = normalizeAnswerText(text)`');
  // The normalized entry must follow the normalize call.
  const normIdx = autoFnBody.indexOf('text = normalizeAnswerText(text)');
  const labelIdx = autoFnBody.indexOf("label: 'auto-answer-clarifying-questions-normalized'");
  assert.ok(normIdx > 0 && labelIdx > normIdx,
    'auto-answer-clarifying-questions-normalized entry must appear AFTER `text = normalizeAnswerText(text)` (callOnce path)');
});

// ── (3) parseAnswersByIndex per-match logging ───────────────────────────────
test('(3.a) parseAnswersByIndex accepts a callerLabel parameter', () => {
  assert.ok(/function parseAnswersByIndex\(text,\s*callerLabel\)/.test(autoFnBody),
    'parseAnswersByIndex must take a `callerLabel` parameter for per-call debug tagging');
});

test('(3.b) parseAnswersByIndex emits a debug entry tagged with the caller label', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*`parseAnswersByIndex\$\{callerLabel \? `:\$\{callerLabel\}` : ''\}`/.test(autoFnBody),
    'parseAnswersByIndex must call appendAutoAnswerClarifyingQuestionsDebug with template label `parseAnswersByIndex${callerLabel ? ":..." : ""}`');
});

test('(3.c) parseAnswersByIndex traces include kept/dropped outcomes', () => {
  assert.ok(/dropped-out-of-range/.test(autoFnBody),
    'expected `dropped-out-of-range` outcome string in parseAnswersByIndex trace');
  assert.ok(/dropped-duplicate/.test(autoFnBody),
    'expected `dropped-duplicate` outcome string in parseAnswersByIndex trace');
  assert.ok(/outcome\s*=\s*['"]kept['"]/.test(autoFnBody),
    'expected `kept` outcome string in parseAnswersByIndex trace');
});

test('(3.d) parseAnswersByIndex preview truncates each match body to 80 chars', () => {
  assert.ok(/body\.slice\(0,\s*80\)/.test(autoFnBody),
    'parseAnswersByIndex must capture a `body.slice(0, 80)` preview per match');
});

test('(3.e) parseAnswersByIndex callers pass a label (callOnce / retry / missing / qN)', () => {
  assert.ok(/parseAnswersByIndex\(text,\s*['"]callOnce['"]\)/.test(autoFnBody),
    'expected parseAnswersByIndex(text, "callOnce") for the initial attempt');
  assert.ok(/parseAnswersByIndex\(cleanedRetry,\s*['"]retry['"]\)/.test(autoFnBody),
    'expected parseAnswersByIndex(cleanedRetry, "retry")');
  assert.ok(/parseAnswersByIndex\(cleanedSecond,\s*['"]missing['"]\)/.test(autoFnBody),
    'expected parseAnswersByIndex(cleanedSecond, "missing")');
  assert.ok(/parseAnswersByIndex\(cleaned,\s*`q\$\{n\}`\)/.test(autoFnBody),
    'expected parseAnswersByIndex(cleaned, `q${n}`) inside per-Q fan-out');
});

// ── (4) lastAgentResponseContainsClarifyingQuestions slice logging ──────────
test('(4.a) lastAgentResponseContainsClarifyingQuestions emits a slice debug entry', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]lastAgentResponseContainsClarifyingQuestions-slice['"][\s\S]*?\}\)/.test(lastClarFn),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"lastAgentResponseContainsClarifyingQuestions-slice"...}) inside lastAgentResponseContainsClarifyingQuestions');
});

test('(4.b) slice entry captures TAIL / BODY / QM[1] substrings', () => {
  assert.ok(/=== TAIL ===/.test(lastClarFn) && /=== BODY ===/.test(lastClarFn) && /=== QM\[1\] ===/.test(lastClarFn),
    'slice entry must include `=== TAIL ===`, `=== BODY ===`, and `=== QM[1] ===` section markers');
});

test('(4.c) slice entry records length+match metadata', () => {
  assert.ok(/tailLen=/.test(lastClarFn) && /bodyLen=/.test(lastClarFn) && /qmMatched=/.test(lastClarFn),
    'slice entry must record tailLen / bodyLen / qmMatched flags in its note');
});

// ── (5) post fan-out pre-append logging ─────────────────────────────────────
test('(5.a) pre-append debug entry exists with target header + merged size', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions-pre-append['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions-pre-append"...}) just before appendToFile in autoAnswerClarifyingQuestionsClarifyingQuestions');
});

test('(5.b) pre-append entry logs the appendToFile target header', () => {
  assert.ok(/appendToFile target header="## \$\{headerName\}"/.test(autoFnBody),
    'pre-append entry must record the resolved `## ${headerName}` target so we can verify which header receives the body');
});

test('(5.c) pre-append entry captures merged map preview (n -> first 120 chars)', () => {
  assert.ok(/v\.slice\(0,\s*120\)/.test(autoFnBody),
    'pre-append preview must truncate each answer to 120 chars');
  assert.ok(/=== MERGED MAP \(n -> first 120 chars\) ===/.test(autoFnBody),
    'pre-append entry must include `=== MERGED MAP (n -> first 120 chars) ===` section marker');
  assert.ok(/=== RENDERED BODY ===/.test(autoFnBody),
    'pre-append entry must include `=== RENDERED BODY ===` section marker (full rendered body)');
});

test('(5.d) pre-append entry appears BEFORE appendToFile call (correct ordering)', () => {
  const preIdx = autoFnBody.indexOf("label: 'auto-answer-clarifying-questions-pre-append'");
  const appendIdx = autoFnBody.indexOf('appendToFile(historyPath, `## ${headerName}`');
  assert.ok(preIdx > 0 && appendIdx > preIdx,
    'auto-answer-clarifying-questions-pre-append must be logged BEFORE the appendToFile call');
});

if (_failed === 0) console.log('\nAll auto-answer-clarifying-questions-debug-instrumentation tests passed.');
else console.error(`\n${_failed} test(s) failed.`);
