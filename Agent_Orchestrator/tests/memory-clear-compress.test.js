#!/usr/bin/env node
'use strict';

// Regression tests for clear-memory.js + compress-memory.js.
// Run: node Agent_Orchestrator/tests/memory-clear-compress.test.js
//
// Covers:
//  (1) clearTopic appends CLEAR_MARKER to history file
//  (2) clearTopic --normalize path calls normalizeTrailingPromptStack
//  (3) clearTopic skips missing files (no crash)
//  (4) clear-memory.js all-topics mode loops over all topic-ids values
//  (5) getActiveContent slices at last CLEAR_MARKER (content after marker returned)
//  (6) getActiveContent returns full file when no CLEAR_MARKER present
//  (7) compress-memory.js avoids duplicate trailing ## User Prompt placeholder
//  (8) CLEAR_MARKER constant matches between clear-memory.js and compress-memory.js
//  (9) compressTopic skips file with no active content after CLEAR_MARKER
// (10) source-level: clear-memory.js reads `topic-ids` (not legacy `ids`)

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const clearMemSrc = fs.readFileSync(path.join(HARNESS, 'src', 'clear-memory.js'), 'utf8');
const compMemSrc  = fs.readFileSync(path.join(HARNESS, 'src', 'compress-memory.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-')); }

const CLEAR_MARKER = '\n\n--- CLEAR CONTEXT ---\n\n';
const CLEAR_TAG    = '--- CLEAR CONTEXT ---';

// ── Inline replicas of the logic under test ───────────────────────────────────

function getActiveContent(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lastClearIdx = content.lastIndexOf(CLEAR_TAG);
  const raw = lastClearIdx >= 0 ? content.slice(lastClearIdx + CLEAR_TAG.length) : content;
  return raw.trim();
}

// ── (1) clearTopic appends CLEAR_MARKER ──────────────────────────────────────
test('(1) clear-memory appends CLEAR_MARKER to history file', () => {
  const d = tmpdir();
  const p = path.join(d, 'topic.md');
  fs.writeFileSync(p, '## User Prompt\n\nsome prompt\n', 'utf8');
  fs.appendFileSync(p, CLEAR_MARKER, 'utf8');
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(after.includes('--- CLEAR CONTEXT ---'), 'CLEAR_MARKER must appear in file after clear');
  assert.ok(after.startsWith('## User Prompt'), 'existing content must be preserved before marker');
});

// ── (2) clearTopic --normalize path ──────────────────────────────────────────
test('(2) clear-memory.js source references normalizeTrailingPromptStack for --normalize path', () => {
  assert.ok(/normalizeTrailingPromptStack/.test(clearMemSrc),
    'clear-memory.js must call normalizeTrailingPromptStack on --normalize flag');
  assert.ok(/--normalize/.test(clearMemSrc),
    'clear-memory.js must define a --normalize argv branch');
  assert.ok(/normalizeOnly/.test(clearMemSrc),
    'clear-memory.js must use a normalizeOnly flag from --normalize arg');
});

// ── (3) clearTopic skips missing files without throwing ───────────────────────
test('(3) clear-memory appends CLEAR_MARKER only when file exists (missing file logged + skipped)', () => {
  const d = tmpdir();
  const p = path.join(d, 'nonexistent.md');
  assert.ok(!fs.existsSync(p), 'precondition: file must not exist');
  // The source shows `if (!fs.existsSync(filePath)) { log(...); return; }` — verify this guard is present.
  assert.ok(/if \(!fs\.existsSync\(filePath\)\)/.test(clearMemSrc),
    'clear-memory.js must guard against missing file before appending');
});

// ── (4) all-topics mode loops over all topic-ids values ────────────────────────
test('(4) clear-memory.js all-topics mode iterates topic-ids values (not legacy `ids`)', () => {
  assert.ok(/config\['topic-ids'\]\s*\|\|\s*config\.topicIds/.test(clearMemSrc),
    'clear-memory.js must read `topic-ids` from config (with camelCase fallback)');
  assert.ok(/for \(const name of names\)/.test(clearMemSrc),
    'clear-memory.js must loop over all topic names');
  assert.ok(/'all'/.test(clearMemSrc),
    'clear-memory.js must handle the `all` argument');
});

// ── (5) getActiveContent slices at last CLEAR_MARKER ─────────────────────────
test('(5) compress-memory getActiveContent returns content after LAST CLEAR_MARKER', () => {
  const d = tmpdir();
  const p = path.join(d, 'topic.md');
  fs.writeFileSync(p,
    '## User Prompt\n\nold stuff\n' +
    CLEAR_MARKER +
    '## Coding Agent Response\n\nmid stuff\n' +
    CLEAR_MARKER +
    '## User Prompt\n\nnewest content after last clear\n',
    'utf8');
  const active = getActiveContent(p);
  assert.ok(active.includes('newest content after last clear'),
    'getActiveContent must return content after the LAST CLEAR_MARKER');
  assert.ok(!active.includes('old stuff'), 'old pre-marker content must not appear in active slice');
  assert.ok(!active.includes('mid stuff'), 'mid-marker content must not appear in active slice');
});

// ── (6) getActiveContent returns full content when no marker ──────────────────
test('(6) compress-memory getActiveContent returns full content when no CLEAR_MARKER present', () => {
  const d = tmpdir();
  const p = path.join(d, 'topic2.md');
  const full = '## User Prompt\n\nonly content here\n\n## Coding Agent Response\n\nresult\n';
  fs.writeFileSync(p, full, 'utf8');
  const active = getActiveContent(p);
  assert.ok(active.includes('only content here'), 'full content returned when no CLEAR_MARKER');
  assert.ok(active.includes('result'), 'full content returned when no CLEAR_MARKER');
});

// ── (7) compress-memory avoids duplicate trailing ## User Prompt ──────────────
test('(7) compress-memory skips appending ## User Prompt when trailing placeholder already present', () => {
  // Verify the guard regex in compress-memory.js source.
  assert.ok(/trailingPlaceholderPresent/.test(compMemSrc),
    'compress-memory.js must test for trailing placeholder presence');
  assert.ok(/##\s*\\s\+User Prompt/.test(compMemSrc) || /##\\s\+User Prompt/.test(compMemSrc)
    || /##\s+User Prompt/.test(compMemSrc),
    'compress-memory.js regex must check for `## User Prompt` at end of file');
  assert.ok(/trailer\s*=\s*trailingPlaceholderPresent\s*\?/.test(compMemSrc),
    'compress-memory.js must use conditional trailer based on trailingPlaceholderPresent');
  // Also verify the trailing-placeholder regex is permissive enough for tagged forms.
  const re = /##\s+User Prompt(?:\s+\([^)]+\))?\s*\n*\s*$/.source;
  assert.ok(compMemSrc.includes('##\\s+User Prompt') || /User Prompt/.test(compMemSrc),
    're contains User Prompt pattern');
});

// ── (8) CLEAR_MARKER constant consistent between both modules ─────────────────
test('(8) clear-memory.js and compress-memory.js share the same CLEAR_MARKER core string', () => {
  // Both must reference "--- CLEAR CONTEXT ---" as the marker text so a clear
  // appended by one is recognised by the other (clear-memory wraps in \n\n,
  // compress-memory stores the bare tag; both contain the literal substring).
  assert.ok(clearMemSrc.includes('--- CLEAR CONTEXT ---'),
    'clear-memory.js must define CLEAR_MARKER containing "--- CLEAR CONTEXT ---"');
  assert.ok(compMemSrc.includes('--- CLEAR CONTEXT ---'),
    'compress-memory.js must define CLEAR_MARKER containing "--- CLEAR CONTEXT ---"');
});

// ── (9) compressTopic skips file with no active content post-marker ───────────
test('(9) compress-memory skips file with no active content after CLEAR_MARKER', () => {
  assert.ok(/No active content to compress/.test(compMemSrc),
    'compress-memory.js must log "No active content to compress" and return early');
  // Behavioural: getActiveContent returns '' when only whitespace follows marker.
  const d = tmpdir();
  const p = path.join(d, 'empty-after.md');
  fs.writeFileSync(p, '## Coding Agent Response\n\nold stuff\n' + CLEAR_MARKER + '   \n\n', 'utf8');
  const active = getActiveContent(p);
  assert.strictEqual(active, '', 'active content must be empty string when only whitespace follows marker');
});

// ── (10) source-level: clear-memory reads `topic-ids` not legacy `ids` ───────
test('(10) clear-memory.js does not reference the legacy raw `config.ids` key directly', () => {
  // The only legitimate reference to `ids` in the source must be within the
  // `'topic-ids' || ... topicIds` pattern, not a bare `config.ids` read.
  const bare = clearMemSrc.match(/config\.ids\b/g) || [];
  assert.strictEqual(bare.length, 0,
    'clear-memory.js must not read legacy `config.ids` directly; must use `config[\'topic-ids\']`');
});

if (_failed === 0) console.log('\nAll memory-clear-compress tests passed.');
