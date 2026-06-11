#!/usr/bin/env node
'use strict';

/**
 * Regression tests for the auto-answer-clarifying-questions debug-log + normalization hardening
 * landed in run-agent.js to address silent failures of the assessment-agent
 * clarifying-question pipeline.
 *
 * Run: node Agent_Orchestrator/tests/auto-answer-clarifying-questions-debug-and-normalize.test.js
 *
 * Source-level guarantees verified:
 *   (A) AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG + AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH constants exist
 *   (B) appendAutoAnswerClarifyingQuestionsDebug helper exists and is invoked at every runClaude
 *       site inside autoAnswerClarifyingQuestionsClarifyingQuestions (initial + retry + missing
 *       + per-Q fan-out + final summary + extractNumberedQuestions parse).
 *   (C) incrementAutoAnswerClarifyingQuestionsFailures helper exists and is called when the
 *       merge still has missing indices.
 *   (D) normalizeAnswerText helper covers `**N.**`, `N)`, `Q N.` / `Answer N:`,
 *       leading `> ` quote markers — verified by behavioural replica matching
 *       the regexes in the source.
 *   (E) Visible placeholder line is emitted for unanswered Qs so failures
 *       are not silent.
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

const autoFnBody = extractFnBody(runAgentSrc, 'autoAnswerClarifyingQuestionsClarifyingQuestions');

// ── (A) constants present ────────────────────────────────────────────────────
test('(A.1) AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG constant defined under STATE_DIR', () => {
  assert.ok(/AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG\s*=\s*path\.join\(STATE_DIR,\s*['"]auto-answer-clarifying-questions-debug\.log['"]\)/.test(runAgentSrc),
    'expected AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG = path.join(STATE_DIR, "auto-answer-clarifying-questions-debug.log")');
});

test('(A.2) AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH constant defined under STATE_DIR', () => {
  assert.ok(/AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH\s*=\s*path\.join\(STATE_DIR,\s*['"]auto-answer-clarifying-questions-failures\.json['"]\)/.test(runAgentSrc),
    'expected AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH = path.join(STATE_DIR, "auto-answer-clarifying-questions-failures.json")');
});

// ── (B) appendAutoAnswerClarifyingQuestionsDebug present + invoked at every runClaude site ──────
test('(B.1) appendAutoAnswerClarifyingQuestionsDebug helper exists', () => {
  assert.ok(/function appendAutoAnswerClarifyingQuestionsDebug\(/.test(runAgentSrc),
    'expected `function appendAutoAnswerClarifyingQuestionsDebug(entry)` helper');
  assert.ok(/fs\.appendFileSync\(AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG/.test(runAgentSrc),
    'appendAutoAnswerClarifyingQuestionsDebug must append to AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG');
});

test('(B.2) appendAutoAnswerClarifyingQuestionsDebug called for the initial auto-answer-clarifying-questions attempt', () => {
  // Match the call with label 'auto-answer-clarifying-questions' (exact string, the initial attempt).
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions"...}) after the initial callOnce');
});

test('(B.3) appendAutoAnswerClarifyingQuestionsDebug called for the retry attempt', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions \(retry\)['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions (retry)"...}) after retry callOnce');
});

test('(B.4) appendAutoAnswerClarifyingQuestionsDebug called for the missing-only re-prompt', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions-missing['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions-missing"...}) after callOnceForMissing');
});

test('(B.5) appendAutoAnswerClarifyingQuestionsDebug called for the per-question fan-out', () => {
  // label is interpolated `auto-answer-clarifying-questions-q${n}` — match the template fragment.
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*`auto-answer-clarifying-questions-q\$\{n\}`[\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:`auto-answer-clarifying-questions-q${n}`...}) inside per-Q fan-out');
});

test('(B.6) appendAutoAnswerClarifyingQuestionsDebug emits a final summary entry after merge', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions-summary['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected a final appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions-summary"...}) after the merge step');
});

test('(B.7) appendAutoAnswerClarifyingQuestionsDebug logs the extractNumberedQuestions parse result', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]extractNumberedQuestions['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"extractNumberedQuestions"...}) right after extractNumberedQuestions(...)');
});

// ── (C) failures counter ─────────────────────────────────────────────────────
test('(C.1) incrementAutoAnswerClarifyingQuestionsFailures helper exists and writes JSON', () => {
  assert.ok(/function incrementAutoAnswerClarifyingQuestionsFailures\(/.test(runAgentSrc),
    'expected `function incrementAutoAnswerClarifyingQuestionsFailures(topicName, missingCount)` helper');
  assert.ok(/fs\.writeFileSync\(AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH/.test(runAgentSrc),
    'incrementAutoAnswerClarifyingQuestionsFailures must persist to AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH');
});

test('(C.2) incrementAutoAnswerClarifyingQuestionsFailures invoked when final merge still has gaps', () => {
  assert.ok(/incrementAutoAnswerClarifyingQuestionsFailures\(topic,\s*finalMissing\.length\)/.test(autoFnBody),
    'expected incrementAutoAnswerClarifyingQuestionsFailures(topic, finalMissing.length) inside the placeholder branch');
});

// ── (D) normalizeAnswerText broader normalization ────────────────────────────
// Replicate the helper inline. Keep regexes in sync with run-agent.js.
function normalizeAnswerText(s) {
  return (s || '').split('\n').map(line => {
    let l = line;
    l = l.replace(/^(\s*)(?:>\s*)+/, '$1');
    l = l.replace(/^(\s*)#{1,6}\s+(?=(?:\*\*)?\s*(?:Q\s*|Answer\s*|Question\s*)?\d+(?:\.|\)|:|\*\*))/i, '$1');
    l = l.replace(/^(\s*)[-*+]\s+(?=(?:\*\*)?\s*(?:Q\s*|Answer\s*|Question\s*)?\d+(?:\.|\)|:|\*\*))/i, '$1');
    l = l.replace(/^(\s*)\*\*\s*(\d+)\s*[.\):]?\s*\*\*\s*/, '$1$2. ');
    l = l.replace(/^(\s*)\*\*\s*(\d+)\s*[.\):]\s+/, '$1$2. ');
    l = l.replace(/^(\s*)(\d+)\s*[\):]\s+/, '$1$2. ');
    l = l.replace(/^(\s*)(?:Q|Question|Answer)\s*(\d+)\s*[.\):]\s+/i, '$1$2. ');
    return l;
  }).join('\n');
}
function parseAnswersByIndex(text, expectedCount) {
  const map = new Map();
  const re = /^\s*(\d+)\.\s+([\s\S]*?)(?=^\s*\d+\.\s+|(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= expectedCount && !map.has(n)) map.set(n, m[2].trim());
  }
  return map;
}

test('(D.0) source defines normalizeAnswerText (renamed from stripLeadingBullets)', () => {
  assert.ok(/function normalizeAnswerText\(s\)/.test(autoFnBody),
    'expected `function normalizeAnswerText(s)` helper inside autoAnswerClarifyingQuestionsClarifyingQuestions');
});

// Fixture (a): single `1. ans` (smoke — must remain a no-op for canonical input).
test('(D.a) fixture: `1. ans` only — pass-through, parsed as Q1', () => {
  const raw = '1. only answer';
  const normalized = normalizeAnswerText(raw);
  assert.strictEqual(normalized, raw, 'canonical input must not change');
  const map = parseAnswersByIndex(normalized, 1);
  assert.strictEqual(map.get(1), 'only answer');
});

// Fixture (b): `**1.** ans **2.** ans` (model wrapped numbers in markdown emphasis).
test('(D.b) fixture: `**1.** ans / **2.** ans` normalizes + parses both', () => {
  const raw = '**1.** first ans\n\n**2.** second ans';
  const normalized = normalizeAnswerText(raw);
  assert.match(normalized, /^1\. first ans/m, 'leading **1.** must become `1. `');
  assert.match(normalized, /^2\. second ans/m, 'leading **2.** must become `2. `');
  const map = parseAnswersByIndex(normalized, 2);
  assert.strictEqual(map.get(1), 'first ans');
  assert.strictEqual(map.get(2), 'second ans');
});

// Fixture (c): `1) ans / 2) ans` (paren-style numbering).
test('(D.c) fixture: `1) ans / 2) ans` normalizes to `1.` / `2.`', () => {
  const raw = '1) first\n\n2) second';
  const normalized = normalizeAnswerText(raw);
  assert.match(normalized, /^1\. first/m);
  assert.match(normalized, /^2\. second/m);
  const map = parseAnswersByIndex(normalized, 2);
  assert.strictEqual(map.get(1), 'first');
  assert.strictEqual(map.get(2), 'second');
});

// Fixture (c.2): `Q 1.` / `Answer 2:` prefixes.
test('(D.c.2) fixture: `Q 1.` / `Answer 2:` prefixes normalize to `N. `', () => {
  const raw = 'Q 1. alpha\n\nAnswer 2: beta';
  const normalized = normalizeAnswerText(raw);
  const map = parseAnswersByIndex(normalized, 2);
  assert.strictEqual(map.get(1), 'alpha');
  assert.strictEqual(map.get(2), 'beta');
});

// Fixture (c.3): leading `> ` quote markers (model wrapped reply in a blockquote).
test('(D.c.3) fixture: leading `> ` quote markers are stripped', () => {
  const raw = '> 1. quoted-first\n> \n> 2. quoted-second';
  const normalized = normalizeAnswerText(raw);
  const map = parseAnswersByIndex(normalized, 2);
  assert.strictEqual(map.get(1), 'quoted-first');
  assert.strictEqual(map.get(2), 'quoted-second');
});

// Fixture (d): merged-paragraph fallback — model returned prose with `1.` / `2.`
// markers embedded (not on their own line). parseAnswersByIndex anchors to
// line-start, so this must NOT yield both answers; the placeholder branch
// then kicks in for the missing ones. This documents the boundary.
test('(D.d) fixture: prose with inline `1.` / `2.` is NOT parsed as numbered (placeholder path triggers)', () => {
  const raw = 'Here are answers: 1. inline first, and 2. inline second.';
  const normalized = normalizeAnswerText(raw);
  const map = parseAnswersByIndex(normalized, 2);
  // Inline numbers in prose intentionally do not match `^\s*N\.\s+` — placeholder
  // branch will fill the gap so the user can see the failure.
  assert.ok(map.size < 2, 'inline numbers buried in prose should not be silently treated as answered');
});

// Fixture (d.2): bullet-wrapped `**1.** ans` (combines bullet + emphasis).
test('(D.d.2) fixture: `- **1.** ans / - **2.** ans` strips bullet AND emphasis', () => {
  const raw = '- **1.** alpha\n\n- **2.** beta';
  const normalized = normalizeAnswerText(raw);
  const map = parseAnswersByIndex(normalized, 2);
  assert.strictEqual(map.get(1), 'alpha');
  assert.strictEqual(map.get(2), 'beta');
});

// ── (E) visible placeholder for unanswered Qs ────────────────────────────────
test('(E.1) fn emits a visible placeholder line for any Q still missing after all escalations', () => {
  assert.ok(/auto-answer-clarifying-questions failed — please answer manually; see \.state\/auto-answer-clarifying-questions-debug\.log/.test(autoFnBody),
    'expected a visible placeholder string referencing .state/auto-answer-clarifying-questions-debug.log for unanswered Qs');
});

test('(E.2) finalMissing computed by walking 1..expectedCount and checking merged', () => {
  assert.ok(/finalMissing\s*=\s*\[\]/.test(autoFnBody) &&
    /for \(let n = 1; n <= expectedCount; n\+\+\) if \(!merged\.has\(n\)\) finalMissing\.push\(n\)/.test(autoFnBody),
    'expected an explicit finalMissing scan over 1..expectedCount before placeholder fill');
});

// ── (F) markdown-heading + unmatched-bold normalization (QA remediation) ─────
test('(F.1) fixture: `### 1. ans` / `### 2. ans` markdown heading prefix strips', () => {
  const raw = '### 1. heading-first\n\n### 2. heading-second';
  const map = parseAnswersByIndex(normalizeAnswerText(raw), 2);
  assert.strictEqual(map.get(1), 'heading-first');
  assert.strictEqual(map.get(2), 'heading-second');
});

test('(F.2) fixture: `**1. ans` (unmatched closing `**`) normalizes to `1. ans`', () => {
  const raw = '**1. unmatched-first\n\n**2. unmatched-second';
  const map = parseAnswersByIndex(normalizeAnswerText(raw), 2);
  assert.strictEqual(map.get(1), 'unmatched-first');
  assert.strictEqual(map.get(2), 'unmatched-second');
});

test('(F.3) source contains markdown-heading strip regex (#{1,6})', () => {
  assert.ok(/#\{1,6\}\\s\+/.test(autoFnBody) || /#{1,6}\\s\+/.test(autoFnBody),
    'normalizeAnswerText must strip leading `#`/`##`/`### ` heading markers before numbered marker');
});

test('(F.4) source contains unmatched-bold strip regex (`**N.` / `**N)` / `**N:`)', () => {
  // Second `**...` replacement that does NOT require closing `**`.
  const m = autoFnBody.match(/\\\*\\\*\\s\*\(\\d\+\)\\s\*\[\.\\\)\:\]\\s\+/g);
  assert.ok(m && m.length >= 1, 'expected unmatched-bold regex `\\*\\*\\s*(\\d+)\\s*[.\\):]\\s+` in normalizeAnswerText');
});

// ── (G) log rotation cap (QA remediation) ────────────────────────────────────
test('(G.1) AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG has a byte-cap constant', () => {
  assert.ok(/AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG_MAX_BYTES\s*=\s*\d+/.test(runAgentSrc),
    'expected AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG_MAX_BYTES constant (size cap for rotation)');
});

test('(G.2) rotateAutoAnswerClarifyingQuestionsDebugLogIfNeeded fn exists and renames to `.1`', () => {
  assert.ok(/function rotateAutoAnswerClarifyingQuestionsDebugLogIfNeeded\(/.test(runAgentSrc),
    'expected `function rotateAutoAnswerClarifyingQuestionsDebugLogIfNeeded()` helper');
  assert.ok(/AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG\s*\+\s*['"]\.1['"]/.test(runAgentSrc),
    'rotation must produce a `.1` rotated file path');
  assert.ok(/fs\.renameSync\(AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG/.test(runAgentSrc),
    'rotation must use fs.renameSync to move the oversize log');
});

test('(G.3) appendAutoAnswerClarifyingQuestionsDebug invokes the rotation helper before appending', () => {
  // The rotation call must appear before the appendFileSync call inside the helper.
  const helperSrc = runAgentSrc.match(/function appendAutoAnswerClarifyingQuestionsDebug\([\s\S]*?\n\}/);
  assert.ok(helperSrc, 'appendAutoAnswerClarifyingQuestionsDebug fn body must be locatable');
  const body = helperSrc[0];
  const rotIdx = body.indexOf('rotateAutoAnswerClarifyingQuestionsDebugLogIfNeeded(');
  const appIdx = body.indexOf('fs.appendFileSync(AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG');
  assert.ok(rotIdx > 0 && appIdx > rotIdx,
    'rotateAutoAnswerClarifyingQuestionsDebugLogIfNeeded() must be called before fs.appendFileSync inside appendAutoAnswerClarifyingQuestionsDebug');
});

// ── (H) strengthened missing-Q prompt (QA remediation) ───────────────────────
test('(H.1) callOnceForMissing prompt asserts exact `N. <answer>` shape', () => {
  assert.ok(/STRICT OUTPUT FORMAT/.test(autoFnBody),
    'callOnceForMissing must include a STRICT OUTPUT FORMAT directive');
  assert.ok(/EXACTLY\s+`N\.\s*<answer>`/.test(autoFnBody) ||
            /EXACTLY\s+\\`N\.\s*<answer>\\`/.test(autoFnBody),
    'prompt must demand the exact `N. <answer>` line shape');
});

test('(H.2) missing-Q prompt forbids known drift patterns (bold/parens/headings/quotes)', () => {
  // Must explicitly tell the model NOT to use the alt patterns the normalizer rescues from.
  assert.ok(/\*\*N\.\*\*/.test(autoFnBody), 'prompt must forbid `**N.**` form');
  assert.ok(/`N\)`/.test(autoFnBody) || /\\`N\\\)\\`/.test(autoFnBody), 'prompt must forbid `N)` form');
  assert.ok(/heading/i.test(autoFnBody), 'prompt must forbid markdown-heading prefixes');
  assert.ok(/blockquote/i.test(autoFnBody), 'prompt must forbid blockquote `>` prefixes');
});

test('(H.3) missing-Q prompt forbids collapsing to a single answer', () => {
  assert.ok(/collapse to a single answer/i.test(autoFnBody),
    'prompt must explicitly forbid collapsing multiple Qs into one answer (root failure mode)');
});

// ── (I) payload-trace appendAutoAnswerClarifyingQuestionsDebug call-sites (B4 requirement) ─────
test('(I.1) callOnce logs `auto-answer-clarifying-questions-payload` label with payload text', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions-payload['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions-payload"...}) inside callOnce before runClaude');
});

test('(I.2) callOnceForMissing logs `auto-answer-clarifying-questions-missing-payload` label with payload text', () => {
  assert.ok(/appendAutoAnswerClarifyingQuestionsDebug\(\{[\s\S]*?label:\s*['"]auto-answer-clarifying-questions-missing-payload['"][\s\S]*?\}\)/.test(autoFnBody),
    'expected appendAutoAnswerClarifyingQuestionsDebug({...label:"auto-answer-clarifying-questions-missing-payload"...}) inside callOnceForMissing before runClaude');
});

test('(I.3) appendAutoAnswerClarifyingQuestionsDebug logs resolved debug-log path on first write (one-shot)', () => {
  assert.ok(/_autoAnswerClarifyingQuestionsDebugPathLogged/.test(runAgentSrc),
    'expected `_autoAnswerClarifyingQuestionsDebugPathLogged` module-level one-shot guard');
  assert.ok(/auto-answer-clarifying-questions debug log path:/i.test(runAgentSrc),
    'expected helper to log("auto-answer-clarifying-questions debug log path: ...") once at first write');
});

// ── (J) queue-inject branch logging (B1 requirement) ────────────────────────
test('(J.1) appendQueueInjectDebug helper exists', () => {
  assert.ok(/function appendQueueInjectDebug\(/.test(runAgentSrc),
    'expected `function appendQueueInjectDebug(entry)` helper');
});

test('(J.2) injectQueuedPromptIntoHistory logs unified branch + retains reuse/fresh-append telemetry labels', () => {
  const fn = runAgentSrc.match(/function injectQueuedPromptIntoHistory\([\s\S]*?\n\}/);
  assert.ok(fn, 'injectQueuedPromptIntoHistory fn body must be locatable');
  const body = fn[0];
  // Consolidated to a SINGLE appendQueueInjectDebug call carrying `unified:true`
  // plus the legacy `reuse`/`fresh-append` branch label (derived from collapsed>0).
  const calls = (body.match(/appendQueueInjectDebug\(/g) || []).length;
  assert.strictEqual(calls, 1,
    `expected exactly one appendQueueInjectDebug call (consolidated entry); got ${calls}`);
  assert.ok(/unified:\s*true/.test(body),
    'expected consolidated debug entry to carry `unified: true` flag');
  assert.ok(/['"]reuse['"]/.test(body) && /['"]fresh-append['"]/.test(body),
    'expected reuse / fresh-append telemetry labels to remain (derived from collapsed>0)');
  assert.ok(/tailHex/.test(body) && /tailLen/.test(body),
    'expected tail hex/length capture (last 80 bytes) in injectQueuedPromptIntoHistory');
  assert.ok(/collapsed/.test(body),
    'expected collapsed-count capture in injectQueuedPromptIntoHistory');
});

if (_failed === 0) console.log('\nAll auto-answer-clarifying-questions-debug-and-normalize tests passed.');
else console.error(`\n${_failed} test(s) failed.`);
