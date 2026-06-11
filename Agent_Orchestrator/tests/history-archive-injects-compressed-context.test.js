'use strict';

/**
 * Tests for Bug D — compressed summary injected into archive stub.
 *
 * Run: node --test Agent_Orchestrator/tests/history-archive-injects-compressed-context.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test } = require('node:test');

const RUN_AGENT_PATH = path.join(__dirname, '..', 'src', 'run-agent.js');
const SRC = fs.readFileSync(RUN_AGENT_PATH, 'utf8');

// Hardcoded pattern (must NOT be extracted from source — source uses JS string escapes
// that readFileSync returns as raw bytes, producing double backslashes that create
// unintended capture groups in new RegExp, causing undefined elements in split results).
const ANY_RESPONSE_HEADER = '(?:Planning|Coding|Assessment)\\s+Agent(?:\\s+\\d+)?\\s+Response(?:\\s+\\([^)\\n]*\\))?';

// Extract parseConversationContext for structural clear-marker assertions.
const PARSE_START = SRC.indexOf('function parseConversationContext(');
const PARSE_END = SRC.indexOf('\nfunction stripTrailingUserPrompt(', PARSE_START);
const PARSE_SRC = PARSE_START >= 0 && PARSE_END > PARSE_START ? SRC.slice(PARSE_START, PARSE_END).trim() : null;

function buildParseFn() {
  if (!PARSE_SRC) return null;
  // eslint-disable-next-line no-new-func
  const factory = new Function('fs', 'CONTEXT_TRUNCATION', 'ANY_RESPONSE_HEADER',
    `${PARSE_SRC}; return parseConversationContext;`);
  return factory(fs, 12000, ANY_RESPONSE_HEADER);
}

const FN_START = SRC.indexOf('async function maybeAutoArchiveHistory(');
assert.ok(FN_START >= 0, 'maybeAutoArchiveHistory not found in run-agent.js');
const FN_END = SRC.indexOf('\nfunction appendToFile(', FN_START);
assert.ok(FN_END > FN_START, 'appendToFile boundary not found after maybeAutoArchiveHistory');
const FN_SRC = SRC.slice(FN_START, FN_END).trim();

const CLEAR_MARKER_NEW = '<!-- CLEAR CONTEXT -->';
const CLEAR_MARKER_OLD = '--- CLEAR CONTEXT ---';

function buildArchiveFn(threshold, extraConfig = {}) {
  const fakeConfig = { 'history-archive-threshold-lines': threshold, ...extraConfig };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs', 'path', 'log', 'config', 'HISTORY_ARCHIVE_CLEAR_MARKER',
    'DEFAULT_HISTORY_ARCHIVE_THRESHOLD',
    `${FN_SRC}; return maybeAutoArchiveHistory;`
  );
  return factory(fs, path, () => {}, fakeConfig, CLEAR_MARKER_NEW, threshold);
}

function makeTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-compress-test-'));
  const filePath = path.join(dir, 'history.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, dir };
}

function contentAfterMarker(fileContent) {
  const newIdx = fileContent.lastIndexOf(CLEAR_MARKER_NEW);
  const oldIdx = fileContent.lastIndexOf(CLEAR_MARKER_OLD);
  let idx = -1, markerLen = 0;
  if (newIdx >= oldIdx && newIdx >= 0) { idx = newIdx; markerLen = CLEAR_MARKER_NEW.length; }
  else if (oldIdx >= 0) { idx = oldIdx; markerLen = CLEAR_MARKER_OLD.length; }
  return idx >= 0 ? fileContent.slice(idx + markerLen) : fileContent;
}

const oversizedContent =
  Array.from({ length: 10 }, (_, i) => `## Section ${i}\n\nContent for section ${i}.\n`).join('\n') +
  '\n\n## User Prompt\n';

test('history-archive-injects-compressed-context > summary appears in parseConversationContext output', async () => {
  const { filePath, dir } = makeTmpFile(oversizedContent);
  const MOCK_SUMMARY = 'MOCK_COMPRESSED_SUMMARY_12345';
  const mockSummarize = async (_content) => MOCK_SUMMARY;

  const fn = buildArchiveFn(5);
  await fn(filePath, { summarizeContent: mockSummarize });

  const result = fs.readFileSync(filePath, 'utf8');

  // (1) Clear marker present.
  assert.ok(
    result.includes(CLEAR_MARKER_NEW),
    'Archive file must contain the new clear marker'
  );

  // (2) Summary in raw file below the clear marker (verified via file read, the canonical
  //     position check — if summary were accidentally placed above the marker, this fails).
  const afterMarker = contentAfterMarker(result);
  assert.ok(
    afterMarker.includes(MOCK_SUMMARY),
    `Summary must appear in content after clear marker. Got: ${afterMarker.slice(0, 300)}`
  );
  assert.ok(
    afterMarker.includes('## Compressed Memory'),
    'Summary must be under ## Compressed Memory header'
  );

  // (3) parseConversationContext correctly recognises the clear marker and can parse
  //     the post-archive file — exercises the actual parsing pipeline so a broken marker
  //     (e.g. reverted to `--- CLEAR CONTEXT ---`) causes this assertion to fail.
  //     Append a fake user prompt to satisfy the non-empty-prompt requirement.
  fs.appendFileSync(filePath, 'FAKE_USER_PROMPT_FOR_PARSE_TEST\n', 'utf8');
  const parseFn = buildParseFn();
  assert.ok(parseFn, 'parseConversationContext could not be extracted from run-agent.js');
  const parseResult = parseFn(filePath);
  assert.ok(
    parseResult !== null,
    'parseConversationContext must return non-null after archive (clear marker must be syntactically correct)'
  );
  assert.ok(
    parseResult.includes('FAKE_USER_PROMPT_FOR_PARSE_TEST'),
    'parseConversationContext must see content written after the clear marker'
  );

  fs.rmSync(dir, { recursive: true });
});

test('history-archive-injects-compressed-context > fallback when summarize throws', async () => {
  const { filePath, dir } = makeTmpFile(oversizedContent);
  const failingSummarize = async () => { throw new Error('LLM offline'); };

  const fn = buildArchiveFn(5);
  await fn(filePath, { summarizeContent: failingSummarize });

  const result = fs.readFileSync(filePath, 'utf8');
  assert.ok(result.includes(CLEAR_MARKER_NEW), 'Archive file must contain clear marker even on LLM failure');
  assert.ok(result.includes('## Coding Agent Response (History Archived)'), 'Archive notice must be present on fallback');
  assert.ok(!result.includes('## Compressed Memory'), 'No summary section on LLM failure fallback');
  assert.ok(/##\s+User Prompt\s*\n?\s*$/.test(result), 'Archive must still end with ## User Prompt on fallback');

  fs.rmSync(dir, { recursive: true });
});

test('history-archive-injects-compressed-context > no LLM call when summarize fn not provided', async () => {
  const { filePath, dir } = makeTmpFile(oversizedContent);

  const fn = buildArchiveFn(5);
  await fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  assert.ok(!result.includes('## Compressed Memory'), 'No summary section when no summarize fn provided');
  assert.ok(result.includes('## User Prompt'), 'Archive stub must still have ## User Prompt');
  assert.ok(result.includes(CLEAR_MARKER_NEW), 'Archive file must contain clear marker');

  fs.rmSync(dir, { recursive: true });
});

test('history-archive-injects-compressed-context > disabled via history-archive-compress-on-archive=false', async () => {
  const { filePath, dir } = makeTmpFile(oversizedContent);
  let called = false;
  const mockSummarize = async () => { called = true; return 'SHOULD_NOT_APPEAR'; };

  const fn = buildArchiveFn(5, { 'history-archive-compress-on-archive': false });
  await fn(filePath, { summarizeContent: mockSummarize });

  const result = fs.readFileSync(filePath, 'utf8');
  assert.ok(!called, 'summarize fn must not be called when history-archive-compress-on-archive=false');
  assert.ok(!result.includes('SHOULD_NOT_APPEAR'), 'Summary must not appear when disabled by config');

  fs.rmSync(dir, { recursive: true });
});
