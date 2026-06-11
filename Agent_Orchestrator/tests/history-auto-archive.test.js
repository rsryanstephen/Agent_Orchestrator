'use strict';

/**
 * Regression tests for maybeAutoArchiveHistory (run-agent.js).
 *
 * Run: node --test Agent_Orchestrator/tests/history-auto-archive.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test } = require('node:test');

const RUN_AGENT_PATH = path.join(__dirname, '..', 'src', 'run-agent.js');
const SRC = fs.readFileSync(RUN_AGENT_PATH, 'utf8');

// Locate function boundaries once.
const FN_START = SRC.indexOf('async function maybeAutoArchiveHistory(');
assert.ok(FN_START >= 0, 'maybeAutoArchiveHistory not found in run-agent.js');
const FN_END = SRC.indexOf('\nfunction appendToFile(', FN_START);
assert.ok(FN_END > FN_START, 'appendToFile boundary not found after maybeAutoArchiveHistory');
const FN_SRC = SRC.slice(FN_START, FN_END).trim();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildArchiveFn(threshold) {
  const CLEAR_MARKER = '--- CLEAR CONTEXT ---';
  const fakeConfig = { 'history-archive-threshold-lines': threshold };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs', 'path', 'log', 'config', 'HISTORY_ARCHIVE_CLEAR_MARKER',
    'DEFAULT_HISTORY_ARCHIVE_THRESHOLD',
    `${FN_SRC}; return maybeAutoArchiveHistory;`
  );
  return factory(fs, path, () => {}, fakeConfig, CLEAR_MARKER, threshold);
}

function makeTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  const filePath = path.join(dir, 'history.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, dir };
}

// ---------------------------------------------------------------------------
// Source-level assertions
// ---------------------------------------------------------------------------

// Requirement: Bug #2 fix — use writeFileSync (replace) not appendFileSync so
// the file is actually shortened after archiving.
test('source: maybeAutoArchiveHistory uses writeFileSync not appendFileSync (Bug #2)', () => {
  assert.ok(FN_SRC.includes('fs.writeFileSync'), 'Expected writeFileSync in maybeAutoArchiveHistory');
  assert.ok(!FN_SRC.includes('fs.appendFileSync'), 'appendFileSync must not appear after Bug #2 fix');
});

// Requirement: Bug #1 fix — always add trailing ## User Prompt after archive
// block so fillEmptyPromptFromQueueOrInteractive detects an empty prompt for
// queue dequeue. The trailer must be unconditional (no existingPromptBody branch).
test('source: trailing ## User Prompt unconditionally present in archive content (Bug #1)', () => {
  assert.ok(!FN_SRC.includes('trailingPlaceholder'), 'trailingPlaceholder conditional must be removed — trailer is now unconditional');
  assert.ok(!FN_SRC.includes('existingPromptBody'), 'existingPromptBody carry-forward must be removed — archive always emits empty ## User Prompt');
  // archiveContent must include the trailer as a literal string (not conditionally).
  const archiveContentIdx = FN_SRC.indexOf('const archiveContent');
  assert.ok(archiveContentIdx >= 0, 'archiveContent assignment must exist');
  const archiveContentSnippet = FN_SRC.slice(archiveContentIdx, archiveContentIdx + 400);
  assert.ok(archiveContentSnippet.includes('## User Prompt'), 'archiveContent literal must embed ## User Prompt trailer');
});

test('source: archive content starts with HISTORY_ARCHIVE_CLEAR_MARKER', () => {
  assert.ok(FN_SRC.includes('HISTORY_ARCHIVE_CLEAR_MARKER'), 'Archive content must reference HISTORY_ARCHIVE_CLEAR_MARKER');
});

// ---------------------------------------------------------------------------
// Functional assertions
// ---------------------------------------------------------------------------

// Requirement: Bug #2 fix — after archive, file must be much shorter than
// original so the next invocation does not trigger another backup.
test('functional: archive REPLACES file so line count drops below threshold (Bug #2)', () => {
  const original = Array.from({ length: 10 }, (_, i) => `## Line ${i}`).join('\n') + '\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  // Archived file must not contain the original line content.
  assert.ok(!result.includes('## Line 0'), 'Original content must be gone after archive (file must be replaced, not appended)');
  // Archived file must contain the CLEAR CONTEXT marker instead.
  assert.ok(result.includes('--- CLEAR CONTEXT ---'), 'Archived file must contain the CLEAR CONTEXT marker');
  const backups = fs.readdirSync(dir).filter(f => f.includes('.archive-'));
  assert.ok(backups.length >= 1, 'Expected at least one backup file');

  fs.rmSync(dir, { recursive: true });
});

// Requirement: Bug #1 fix — archived file must end with ## User Prompt even
// when the original file already ended with ## User Prompt.
test('functional: archived file ends with ## User Prompt when original already had one (Bug #1)', () => {
  const original =
    Array.from({ length: 10 }, (_, i) => `## Line ${i}`).join('\n') +
    '\n\n---\n\n## User Prompt\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    /##\s+User Prompt\s*\n?\s*$/.test(result),
    'Archived file must end with ## User Prompt so queue dequeue can detect empty prompt'
  );

  fs.rmSync(dir, { recursive: true });
});

// Requirement: Bug #2 fix — calling archive twice must NOT create a second
// backup because the file after the first archive is already below threshold.
test('functional: second archive call is a no-op when file is already below threshold (Bug #2)', () => {
  const original = Array.from({ length: 10 }, (_, i) => `## Line ${i}`).join('\n') + '\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath); // first archive — creates backup
  fn(filePath); // second call — file now small, no new backup

  const backups = fs.readdirSync(dir).filter(f => f.includes('.archive-'));
  assert.strictEqual(backups.length, 1, 'Expected exactly 1 backup after two calls');

  fs.rmSync(dir, { recursive: true });
});

// Regression: archive must NOT carry forward a tagged (queue-injected) prompt body.
// Tagged headers like `(From the Queue)` must be dropped so the next run dequeues
// the next queue item rather than re-executing the already-dequeued task.
test('functional: archived file has EMPTY ## User Prompt when original had tagged (From the Queue) body', () => {
  const original =
    Array.from({ length: 10 }, (_, i) => `## Line ${i}`).join('\n') +
    '\n\n---\n\n## User Prompt (From the Queue)\n\nThis is a queued prompt that must NOT survive archive.\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  // Must end with empty ## User Prompt so queue dequeue fires on next run.
  assert.ok(
    /##\s+User Prompt\s*\n?\s*$/.test(result),
    'Archived file must end with empty ## User Prompt — tagged (From the Queue) body must be dropped'
  );
  // The queued body must NOT appear in the archive.
  assert.ok(
    !result.includes('This is a queued prompt that must NOT survive archive.'),
    'Tagged (From the Queue) prompt body must not be carried forward into archive'
  );

  fs.rmSync(dir, { recursive: true });
});

// Requirement: archive content must include the CLEAR CONTEXT marker so that
// parseConversationContext correctly identifies the start of active context.
test('functional: archived file contains CLEAR CONTEXT marker', () => {
  const original = Array.from({ length: 10 }, (_, i) => `## Line ${i}`).join('\n') + '\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    result.includes('--- CLEAR CONTEXT ---'),
    'Archived file must contain CLEAR CONTEXT marker'
  );

  fs.rmSync(dir, { recursive: true });
});
