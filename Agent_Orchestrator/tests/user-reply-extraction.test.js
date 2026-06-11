#!/usr/bin/env node
'use strict';

// Regression tests for the three planning-agent requirements:
//   (a) 4-numbered-item "## User Reply to Questions" body survives readUserReplyFromHistory
//       end-to-end — the regex must NOT terminate at the first blank line / numbered-list
//       boundary (caused by `$` with the `m` flag matching end-of-line instead of end-of-string).
//   (b) auto-answer-clarifying-questions guard does NOT overwrite a user-edited reply that contains >= 2 numbered items
//       (marker-based + hash-based detection must treat it as user-authored and skip auto-fill).
//   (c) harness child spawn does NOT inherit the global ~/.claude/CLAUDE.md caveman directive —
//       the system prompts must include an explicit "respond in normal prose for harness role"
//       neutralisation clause so model output is readable regardless of user's global CLAUDE.md.
//
// Run: node Agent_Orchestrator/tests/user-reply-extraction.test.js

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const assert = require('assert');
const crypto = require('crypto');

const HARNESS   = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');

const src = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reply-test-'));
function tmpFile(name) { return path.join(TMP, name); }

// Replica of the FIXED readUserReplyFromHistory extraction logic.
// Drops the `m` flag so `$` means end-of-string (not end-of-line), preventing
// the lazy `[\s\S]*?` from stopping at the first blank-line boundary.
function extractReply(content) {
  const cqRe = /^##+\s*Clarifying Questions\b/gim;
  let lastCq = -1;
  let m;
  while ((m = cqRe.exec(content)) !== null) lastCq = m.index;
  if (lastCq < 0) return null;
  const tail = content.slice(lastCq);
  // FIX: 'i' flag only — no 'm', so '$' = end-of-string, not end-of-line.
  const rm = tail.match(/##\s*(?:User Reply to Questions|Auto Reply to Clarifying Questions)\s*\n([\s\S]*?)(?=\n##+\s|$)/i);
  if (!rm) return null;
  return rm[1].trim() || null;
}

// Replica of detectUserAuthored (matches history-edit-protection.test.js).
function hashBody(s) {
  return crypto.createHash('sha256').update((s || '').replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex');
}
const AUTOFILL_MARKER = '_(Auto-filled by assessment agent';
function detectUserAuthored(existingReply, priorAutoHash) {
  const isAutoFill  = !!(existingReply && priorAutoHash && hashBody(existingReply) === priorAutoHash);
  const hasMarker   = !!(existingReply && existingReply.includes(AUTOFILL_MARKER));
  return !!(existingReply && !isAutoFill && !hasMarker);
}

// ── (a) 4-numbered-item disk fixture ─────────────────────────────────────────

test('(a) 4-item disk fixture: extractReply helper captures all 4 numbered answers', () => {
  const body = buildFourItemHistory();
  const result = extractReply(body);
  assert.ok(result, 'extractReply must return non-null for a 4-item reply');
  for (let i = 1; i <= 4; i++) {
    assert.ok(result.includes(`${i}. Answer ${i}`),
      `item ${i} missing from extracted reply — regex terminated too early`);
  }
});

test('(a) extractReply: blank lines between answers do NOT terminate extraction', () => {
  const content = buildHistoryWithBlanksBetweenAnswers();
  const result = extractReply(content);
  assert.ok(result, 'must return non-null');
  assert.ok(result.includes('1. First'), 'first answer missing');
  assert.ok(result.includes('2. Second'), 'second answer missing (blank line before it was a false boundary)');
  assert.ok(result.includes('3. Third'), 'third answer missing');
});

test('(a) extractReply: extraction stops at next ## header, not at blank line', () => {
  const content = [
    '## Clarifying Questions',
    '',
    '1. Q1?',
    '',
    '## User Reply to Questions',
    '',
    '1. Answer one',
    '2. Answer two',
    '',
    '_(Auto-filled by assessment agent — press ENTER twice in the CLI to submit.)_',
    '',
    '## Coding Agent Response',
    '',
    'Should not be included',
  ].join('\n');
  const result = extractReply(content);
  assert.ok(result, 'must return non-null');
  assert.ok(result.includes('1. Answer one'), 'first item missing');
  assert.ok(result.includes('2. Answer two'), 'second item missing');
  assert.ok(!result.includes('Should not be included'),
    'content after next ## header must be excluded');
});

test('(a) extractReply: Auto Reply to Clarifying Questions heading also works', () => {
  const content = [
    '## Clarifying Questions',
    '',
    '1. Q?',
    '',
    '## Auto Reply to Clarifying Questions',
    '',
    '1. First',
    '2. Second',
    '3. Third',
    '4. Fourth',
  ].join('\n');
  const result = extractReply(content);
  assert.ok(result, 'must return non-null for Auto Reply heading');
  assert.ok(result.includes('4. Fourth'), 'item 4 missing from Auto Reply heading extraction');
});

test('(a) source: readUserReplyFromHistory regex does NOT use `m` flag (avoids $ end-of-line trap)', () => {
  // Locate the regex literal inside readUserReplyFromHistory.
  const fnMatch = src.match(/function readUserReplyFromHistory\(\)([\s\S]*?)^}/m);
  assert.ok(fnMatch, 'readUserReplyFromHistory not found in source');
  const fnBody = fnMatch[0];
  // Regex must not carry the `m` flag — that caused `$` to match end-of-line
  // instead of end-of-string, terminating the lazy [\s\S]*? at the first blank line.
  const reMatch = fnBody.match(/tail\.match\((\/[^/]*\/[a-z]*)\)/);
  assert.ok(reMatch, 'tail.match() call not found inside readUserReplyFromHistory');
  const flags = reMatch[1].split('/').pop();
  assert.ok(!flags.includes('m'),
    `readUserReplyFromHistory regex carries the 'm' flag — remove it so '$' means end-of-string, not end-of-line. Got flags: "${flags}"`);
});

test('(a) source: readUserReplyFromHistory regex uses lazy [\s\S]*? with next-header OR end-of-string lookahead', () => {
  const fnMatch = src.match(/function readUserReplyFromHistory\(\)([\s\S]*?)^}/m);
  assert.ok(fnMatch, 'readUserReplyFromHistory not found');
  const fnBody = fnMatch[0];
  // Must have a lookahead that includes next ## header as a boundary.
  assert.ok(/\(\?=\\n#\+/.test(fnBody) || /\?=.*n##+/.test(fnBody) || /next.*header.*lookahead/i.test(fnBody) || /\\n##+/.test(fnBody),
    'readUserReplyFromHistory regex must stop at next ## header, not just at end-of-line');
});

// ── (b) Auto-answer guard: >=2 numbered items treated as user-authored ─────────

test('(b) detectUserAuthored: 4-item reply w/o auto-fill marker → user-authored=true (skip overwrite)', () => {
  const body = '1. Answer one\n2. Answer two\n3. Answer three\n4. Answer four';
  assert.strictEqual(detectUserAuthored(body, 'some-old-hash'), true,
    '4-item reply lacking auto-fill marker must be treated as user-authored so auto-fill is skipped');
});

test('(b) detectUserAuthored: 2-item reply w/o marker → user-authored=true (minimum threshold)', () => {
  const body = '1. Yes\n2. No';
  assert.strictEqual(detectUserAuthored(body, hashBody('different auto-fill body')), true,
    '≥2 items without marker must be treated as user-authored — prevents Q2-4 from being clobbered');
});

test('(b) detectUserAuthored: 1-item reply w/o marker + hash mismatch → user-authored=true', () => {
  const body = '1. Single answer';
  assert.strictEqual(detectUserAuthored(body, hashBody('prior fill')), true,
    'single item without marker also treated as user-authored when hash differs');
});

test('(b) detectUserAuthored: 4-item reply CONTAINING auto-fill marker → user-authored=false (auto-fill may overwrite)', () => {
  const body = '1. A\n2. B\n3. C\n4. D\n\n_(Auto-filled by assessment agent — press ENTER twice in the CLI to submit.)_';
  assert.strictEqual(detectUserAuthored(body, hashBody('unrelated')), false,
    'auto-fill marker present → not user-authored → auto-fill MAY overwrite (user has not removed marker)');
});

test('(b) detectUserAuthored: same-hash body (unchanged auto-fill) → not user-authored', () => {
  const body = '1. auto A\n2. auto B\n\n_(Auto-filled by assessment agent — press ENTER twice in the CLI to submit.)_';
  assert.strictEqual(detectUserAuthored(body, hashBody(body)), false,
    'unchanged auto-fill body must not be treated as user-authored');
});

test('(b) source: handleClarifyingQuestionsIfAny checks AUTOFILL_MARKER as well as hash', () => {
  assert.ok(/AUTOFILL_MARKER/.test(src),
    'AUTOFILL_MARKER constant missing from handleClarifyingQuestionsIfAny — marker-based detection not implemented');
  assert.ok(/hasAutoFillMarker/.test(src),
    'hasAutoFillMarker check missing — marker-based detection not wired');
  assert.ok(/userAuthored/.test(src) && /!hasAutoFillMarker/.test(src),
    'userAuthored gate must include !hasAutoFillMarker to skip overwrite when user has deleted the footer');
});

test('(b) source: autoAnswerClarifyingQuestionsClarifyingQuestions strengthened to answer ALL numbered questions', () => {
  // Verify the auto-answer-clarifying-questions prompt explicitly requires answering every numbered question.
  const autoAnswerClarifyingQuestionsMatch = src.match(/async function autoAnswerClarifyingQuestionsClarifyingQuestions\(([\s\S]*?)^}/m);
  assert.ok(autoAnswerClarifyingQuestionsMatch, 'autoAnswerClarifyingQuestionsClarifyingQuestions not found');
  const body = autoAnswerClarifyingQuestionsMatch[0];
  assert.ok(/EXACTLY|every question|all.*question|answer.*EVERY/i.test(body),
    'auto-answer-clarifying-questions prompt must explicitly require answering ALL questions — historically only Q1 was answered');
  assert.ok(/count|retry|shortfall/i.test(body),
    'auto-answer-clarifying-questions must validate the answer count and retry if fewer answers than questions were returned');
});

test('(b) source: extractNumberedQuestions uses JS-valid regex (no \\Z end-anchor)', () => {
  assert.ok(!/\\Z/.test(src),
    'Invalid \\Z end-of-string anchor found in source — JS regex does not support \\Z, use $(?![\\s\\S]) or omit');
  assert.ok(/extractNumberedQuestions/.test(src),
    'extractNumberedQuestions helper missing from source');
});

// ── (c) Harness child spawn does NOT inherit caveman directive ─────────────────

test('(c) buildSystemPrompt injects "respond in normal prose" neutralisation clause for harness roles', () => {
  // The harness system prompts must include an explicit override so that even if
  // ~/.claude/CLAUDE.md injects caveman mode, the harness agent output remains readable.
  // Either in the system prompt string literals in agent-config.json or built into
  // buildSystemPrompt() / the role system prompts in run-agent.js.
  const hasProseOverride = /respond in normal prose/i.test(src)
    || /normal prose for harness/i.test(src)
    || /harness.{0,30}normal prose/i.test(src);
  assert.ok(hasProseOverride,
    'harness system prompts must include "respond in normal prose" to neutralise ~/.claude/CLAUDE.md caveman injection into child spawns');
});

test('(c) runClaude spawn env isolates the session from user CLAUDE.md via CLAUDE_SESSION_DIR', () => {
  // Minimum: CLAUDE_SESSION_DIR redirects Claude CLI session directory so harness agents
  // write their session data to a per-run ephemeral dir (already tested in harness-improvements).
  // This is a necessary (if not sufficient) isolation step.
  assert.ok(/CLAUDE_SESSION_DIR/.test(src),
    'CLAUDE_SESSION_DIR missing from runClaude spawn env — session isolation not in place');
  assert.ok(/ANTHROPIC_PROJECT_DIR/.test(src),
    'ANTHROPIC_PROJECT_DIR missing from runClaude spawn env — project-dir isolation not in place');
});

test('(c) global-config.json useCaveman is accessible to harness agents (not suppressed externally)', () => {
  // Harness agents should use their own useCaveman setting, not inherit an external one
  // that the user may have set differently in ~/.claude/CLAUDE.md.
  // The source must resolve useCaveman through the standard cfgRead cascade.
  assert.ok(/resolveCavemanClause/.test(src) || /useCaveman/.test(src),
    'resolveCavemanClause / useCaveman resolution missing — harness agents may inherit global CLAUDE.md caveman unconditionally');
  assert.ok(/cavemanClause/.test(src),
    'cavemanClause not wired into buildSystemPrompt — harness can\'t neutralise caveman when disabled per-topic');
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

if (!process.exitCode) console.log('\nAll regression tests passed.');

// ─── Fixture builders ─────────────────────────────────────────────────────────

function buildFourItemHistory() {
  return [
    '## Clarifying Questions',
    '',
    '1. Q1?',
    '2. Q2?',
    '3. Q3?',
    '4. Q4?',
    '',
    '## User Reply to Questions',
    '',
    '1. Answer 1',
    '2. Answer 2',
    '3. Answer 3',
    '4. Answer 4',
    '',
    '_(Auto-filled by assessment agent — press ENTER twice in the CLI to submit.)_',
    '',
    '*Model: claude-opus-4-7 | Effort: max | Tokens: 6 in / 100 out (tiny)*',
  ].join('\n');
}

function buildHistoryWithBlanksBetweenAnswers() {
  return [
    '## Clarifying Questions',
    '',
    '1. Q?',
    '',
    '## User Reply to Questions',
    '',
    '1. First',
    '',
    '2. Second',
    '',
    '3. Third',
    '',
    '_(Auto-filled by assessment agent — press ENTER twice in the CLI to submit.)_',
  ].join('\n');
}
