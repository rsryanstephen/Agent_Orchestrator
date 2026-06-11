'use strict';

/**
 * Bug C regression tests: maybeAutoArchiveHistory must preserve a user-typed
 * (untagged, non-empty) trailing prompt body while dropping tagged bodies so
 * queue dequeue still fires correctly.
 *
 * Run: node --test Agent_Orchestrator/tests/history-auto-archive-preserves-typed-prompt.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test } = require('node:test');

const RUN_AGENT_PATH = path.join(__dirname, '..', 'src', 'run-agent.js');
const SRC = fs.readFileSync(RUN_AGENT_PATH, 'utf8');

const FN_START = SRC.indexOf('async function maybeAutoArchiveHistory(');
assert.ok(FN_START >= 0, 'maybeAutoArchiveHistory not found in run-agent.js');
const FN_END = SRC.indexOf('\nfunction appendToFile(', FN_START);
assert.ok(FN_END > FN_START, 'appendToFile boundary not found after maybeAutoArchiveHistory');
const FN_SRC = SRC.slice(FN_START, FN_END).trim();

// Extract the HISTORY_ARCHIVE_CLEAR_MARKER constant from source so the test is
// independent of whether Bug B has already updated the sentinel value.
const MARKER_MATCH = SRC.match(/const HISTORY_ARCHIVE_CLEAR_MARKER\s*=\s*'([^']+)'/);
assert.ok(MARKER_MATCH, 'HISTORY_ARCHIVE_CLEAR_MARKER constant not found in run-agent.js');
const CLEAR_MARKER = MARKER_MATCH[1];

const DEFAULT_THRESHOLD = 4000;

function buildArchiveFn(threshold) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-typed-prompt-test-'));
  const filePath = path.join(dir, 'history.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, dir };
}

function makeOverThresholdPrefix(lineCount) {
  return Array.from({ length: lineCount }, (_, i) => `## Section ${i}\n\nSome content here.\n`).join('\n');
}

// ---------------------------------------------------------------------------
// Case 1: untagged non-empty prompt body -> preserved in archive
// ---------------------------------------------------------------------------
test('history-auto-archive-preserves-typed-prompt > carries untagged typed body into new file', () => {
  const original =
    makeOverThresholdPrefix(10) +
    '\n\n---\n\n## User Prompt\n\nThis is my typed question.\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    result.includes('This is my typed question.'),
    'Untagged non-empty prompt body must be preserved in archive file'
  );
  // Body must appear after ## User Prompt
  const promptIdx = result.lastIndexOf('## User Prompt');
  const bodyIdx = result.indexOf('This is my typed question.', promptIdx);
  assert.ok(bodyIdx > promptIdx, 'Body must follow the ## User Prompt header in archive');

  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Case 2: tagged (From the Queue) non-empty body -> dropped (prevent re-inject)
// ---------------------------------------------------------------------------
test('history-auto-archive-preserves-typed-prompt > drops tagged (From the Queue) body', () => {
  const original =
    makeOverThresholdPrefix(10) +
    '\n\n---\n\n## User Prompt (From the Queue)\n\nThis queued body must be dropped.\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    !result.includes('This queued body must be dropped.'),
    'Tagged (From the Queue) prompt body must NOT be carried forward — would cause re-injection'
  );
  // Archive must still end with empty ## User Prompt so queue dequeue fires.
  assert.ok(
    /##\s+User Prompt\s*\n?\s*$/.test(result),
    'Archived file must end with empty ## User Prompt after dropping tagged body'
  );

  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Case 3: untagged but empty body -> placeholder stays empty (queue dequeue fires)
// ---------------------------------------------------------------------------
test('history-auto-archive-preserves-typed-prompt > untagged empty body leaves placeholder empty', () => {
  const original =
    makeOverThresholdPrefix(10) +
    '\n\n---\n\n## User Prompt\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  // Must end with empty ## User Prompt so queue dequeue fires on next run.
  assert.ok(
    /##\s+User Prompt\s*\n?\s*$/.test(result),
    'Archived file must end with empty ## User Prompt when original body was empty'
  );

  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Case 4: no trailing ## User Prompt at all -> archive content matches baseline
// ---------------------------------------------------------------------------
test('history-auto-archive-preserves-typed-prompt > no trailing prompt section produces standard archive', () => {
  const original =
    makeOverThresholdPrefix(10) +
    '\n\n## Coding Agent Response\n\nSome response without a trailing user prompt.\n';
  const { filePath, dir } = makeTmpFile(original);
  const fn = buildArchiveFn(5);

  fn(filePath);

  const result = fs.readFileSync(filePath, 'utf8');
  // Archive must still contain the clear marker.
  assert.ok(
    result.includes(CLEAR_MARKER),
    'Archive must contain the HISTORY_ARCHIVE_CLEAR_MARKER even without a trailing prompt'
  );
  // Archive must still end with ## User Prompt placeholder.
  assert.ok(
    /##\s+User Prompt\s*\n?\s*$/.test(result),
    'Archive must end with ## User Prompt placeholder when original had no trailing prompt'
  );
  // No original content must leak.
  assert.ok(
    !result.includes('Some response without a trailing user prompt.'),
    'Original response content must not appear in the archive stub'
  );

  fs.rmSync(dir, { recursive: true });
});
