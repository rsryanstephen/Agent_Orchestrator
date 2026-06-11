#!/usr/bin/env node
'use strict';

// Regression tests for promptForUserReply multi-line + disk-wins behavior.
// Plan items: Item 2 (sentinels + multi-line accumulator), Item 3 (multi-line
// accumulator, two-blank-lines submits), Item 4 (file-on-disk wins).
// Run: node Agent_Orchestrator/tests/promptForUserReply.multiline.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Extract the readline-driven helper body (renamed from promptForUserReply
// when IPC mode was added — promptForUserReply now dispatches to either IPC
// or this helper).
const fnMatch = src.match(/function _readlinePromptForUserReply\(\)\s*\{[\s\S]*?\r?\n\}\r?\n/);
assert.ok(fnMatch, '_readlinePromptForUserReply() not found in run-agent.js');
const fnSrc = fnMatch[0];

// ── Multi-line accumulator (Items 2/3) ───────────────────────────────────────
test('Item 3: accumulator pushes every line event into bufferLines[]', () => {
  assert.ok(/const bufferLines = \[\]/.test(fnSrc), 'bufferLines[] declaration missing');
  assert.ok(/bufferLines\.push\(line\)/.test(fnSrc), 'bufferLines.push(line) missing');
});

test('Item 3: submit requires TWO consecutive blank lines (no single-blank-Enter trigger)', () => {
  assert.ok(/prevNonBlank/.test(fnSrc), 'prevNonBlank tracker missing');
  assert.ok(/blankRun/.test(fnSrc), 'blankRun counter missing — needed for two-blank-line trigger');
  assert.ok(/blankRun >= 2 && prevNonBlank/.test(fnSrc),
    'two-blank-lines + prev-non-blank submit guard missing');
  // Must NOT submit on a single blank line after content (regression guard).
  assert.ok(!/if \(prevNonBlank\) \{ finish\(\); return; \}/.test(fnSrc),
    'single-blank-Enter submit trigger still present — risk of accidental submit');
});

test('Item 2: both :submit and :s sentinels submit accumulated buffer', () => {
  assert.ok(/trimmed === ':submit' \|\| trimmed === ':s'/.test(fnSrc),
    ':submit / :s sentinel branch missing');
});

test('Item 2: banner documents :submit-sentinel and two-blank-line submit mechanic', () => {
  assert.ok(/type :submit \(or :s\) on its own line to submit/.test(fnSrc),
    'updated banner copy missing :submit guidance');
  assert.ok(/ENTER twice on consecutive blank lines/.test(fnSrc),
    'banner must mention two-blank-line fallback');
  assert.ok(!/Enter on a blank line TWICE/.test(fnSrc),
    'stale "TWICE" banner copy still present');
});

// ── Disk-wins (Item 4) ───────────────────────────────────────────────────────
test('Item 4: finish() calls readUserReplyFromHistory FIRST after saveAllVsCodeBuffers', () => {
  const saveIdx = fnSrc.indexOf('saveAllVsCodeBuffers()');
  const readIdx = fnSrc.indexOf('readUserReplyFromHistory()');
  const bufJoinIdx = fnSrc.indexOf("bufferLines.join('\\n')");
  assert.ok(saveIdx > 0 && readIdx > saveIdx,
    'readUserReplyFromHistory() must come AFTER saveAllVsCodeBuffers()');
  assert.ok(bufJoinIdx > readIdx,
    'CLI buffer must only be consumed AFTER disk reply check');
});

test('Item 4: when disk reply non-empty, CLI buffer is discarded', () => {
  assert.ok(/fileReply && fileReply\.trim\(\)/.test(fnSrc),
    'disk-non-empty guard missing');
  assert.ok(/CLI buffer discarded/.test(fnSrc),
    'discard-CLI message missing');
  assert.ok(/resolve\(fileReply\);/.test(fnSrc),
    'resolve(fileReply) branch missing');
});

test('Item 4: empty disk + non-empty CLI buffer falls back to CLI', () => {
  assert.ok(/resolve\(buf\);/.test(fnSrc),
    'resolve(buf) fallback missing');
  assert.ok(/empty reply — re-prompting/.test(fnSrc),
    'empty-both re-prompt path missing');
});

test('Item 4: auto-fill banner references :submit / two-blank-line mechanic for consistency', () => {
  assert.ok(/Auto-filled by assessment agent — type :submit \(or :s\), or press ENTER twice on consecutive blank lines, to submit\./.test(src),
    'auto-fill banner not updated to reference :submit + two-blank-line mechanic');
  assert.ok(!/Auto-filled by assessment agent — press ENTER twice\b(?! on)/.test(src),
    'stale plain "ENTER twice" auto-fill banner still present');
});

// ── Runtime behavior: re-implement the same control-flow contract here ───────
function makeHandler() {
  const bufferLines = [];
  const state = { prevNonBlank: false, blankRun: 0, submitted: false };
  function onLine(line) {
    const trimmed = line.trim();
    if (trimmed === ':submit' || trimmed === ':s') { state.submitted = true; return; }
    if (trimmed === '') {
      state.blankRun++;
      if (state.blankRun >= 2 && state.prevNonBlank) { state.submitted = true; return; }
      bufferLines.push(line);
    } else {
      bufferLines.push(line);
      state.prevNonBlank = true;
      state.blankRun = 0;
    }
  }
  return { bufferLines, state, onLine };
}

test('Runtime: 8 numbered answers + TWO blank lines submits all 8 (no truncation)', () => {
  const { bufferLines, state, onLine } = makeHandler();
  for (let i = 1; i <= 8; i++) onLine(`${i}. answer ${i}`);
  onLine('');
  assert.ok(!state.submitted, 'single blank line should NOT submit');
  onLine('');
  assert.ok(state.submitted, 'second consecutive blank should submit');
  while (bufferLines.length && !bufferLines[bufferLines.length - 1].trim()) bufferLines.pop();
  assert.strictEqual(bufferLines.length, 8, `expected 8 lines accumulated, got ${bufferLines.length}`);
  assert.strictEqual(bufferLines[0], '1. answer 1');
  assert.strictEqual(bufferLines[7], '8. answer 8');
});

test('Runtime: :submit sentinel mid-buffer submits accumulated content', () => {
  const { bufferLines, state, onLine } = makeHandler();
  onLine('1. first');
  onLine('2. second');
  onLine(':submit');
  assert.ok(state.submitted, ':submit did not fire submission');
  assert.strictEqual(bufferLines.length, 2);
});

test('Runtime: :s short sentinel also submits', () => {
  const { bufferLines, state, onLine } = makeHandler();
  onLine('answer');
  onLine(':s');
  assert.ok(state.submitted, ':s did not fire submission');
  assert.strictEqual(bufferLines.length, 1);
});

test('Runtime: single blank Enter after content does NOT submit (accidental-submit guard)', () => {
  const { state, onLine } = makeHandler();
  onLine('partial answer');
  onLine('');
  assert.ok(!state.submitted, 'single blank after content must NOT submit — regression guard');
});

test('Runtime: single Enter on empty buffer does NOT submit alone', () => {
  const { state, onLine } = makeHandler();
  onLine('');
  assert.ok(!state.submitted, 'lone leading blank should NOT submit');
  onLine('');
  assert.ok(!state.submitted, 'two blanks with NO content should NOT submit (prevNonBlank guard)');
});

test('Runtime: blank line mid-content does not submit; content can resume', () => {
  const { bufferLines, state, onLine } = makeHandler();
  onLine('first paragraph');
  onLine('');
  assert.ok(!state.submitted, 'one blank between paragraphs must not submit');
  onLine('second paragraph');
  onLine('');
  onLine('');
  assert.ok(state.submitted, 'two blanks after second paragraph must submit');
  while (bufferLines.length && !bufferLines[bufferLines.length - 1].trim()) bufferLines.pop();
  assert.strictEqual(bufferLines.length, 3, 'should retain both paragraphs + interior blank');
});

// ── IPC mode (parallel broker) ───────────────────────────────────────────────

test('promptForUserReply emits process.send({type:\'question\'}) when process.connected', () => {
  assert.ok(/process\.send\s*&&\s*process\.connected/.test(src),
    'IPC mode guard `process.send && process.connected` missing');
  assert.ok(/process\.send\(\{[\s\S]*?type:\s*['"]question['"]/.test(src),
    'IPC path must call process.send({type:\'question\', ...})');
  assert.ok(/role:\s*_currentRole/.test(src),
    'IPC payload must include the current role');
  assert.ok(/questionsText/.test(src),
    'IPC payload must include questionsText so the broker can render the questions');
});

test('promptForUserReply IPC path resolves on {type:\'answer\'} message from parent', () => {
  assert.ok(/m\.type\s*===\s*['"]answer['"]/.test(src),
    'IPC path must wait for {type:\'answer\'} message from parent broker');
});

test('IPC mode does NOT open readline on stdin (no double-stdin contention)', () => {
  const ipcBranch = src.match(/if \(process\.send && process\.connected\) \{[\s\S]*?\n\s*\}/);
  assert.ok(ipcBranch, 'could not locate IPC branch');
  assert.ok(!/readline\.createInterface/.test(ipcBranch[0]),
    'IPC branch must NOT open readline — broker owns stdin');
});

test('currentRole module-level tracker is set at every phase entry', () => {
  assert.ok(/setCurrentRole\(['"]planning['"]\)/.test(src), 'planning phase must call setCurrentRole(\'planning\')');
  assert.ok(/setCurrentRole\(['"]coding['"]\)/.test(src), 'coding phase must call setCurrentRole(\'coding\')');
  assert.ok(/setCurrentRole\(['"]assessment['"]\)/.test(src), 'assessment phase must call setCurrentRole(\'assessment\')');
});
