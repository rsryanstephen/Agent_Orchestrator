'use strict';

/**
 * Regression: CLEAR CONTEXT marker must be HTML comment, never YAML front-matter dashes.
 *
 * Run: node --test Agent_Orchestrator/tests/history-archive-marker-not-frontmatter.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, describe } = require('node:test');

const RUN_AGENT_PATH = path.join(__dirname, '..', 'src', 'run-agent.js');
const SRC = fs.readFileSync(RUN_AGENT_PATH, 'utf8');

// Extract HISTORY_ARCHIVE_CLEAR_MARKER constant value from source.
const MARKER_MATCH = SRC.match(/const HISTORY_ARCHIVE_CLEAR_MARKER\s*=\s*'([^']+)'/);
assert.ok(MARKER_MATCH, 'HISTORY_ARCHIVE_CLEAR_MARKER not found in run-agent.js');
const LIVE_MARKER = MARKER_MATCH[1];

// Extract maybeAutoArchiveHistory source for runtime testing.
const FN_START = SRC.indexOf('async function maybeAutoArchiveHistory(');
assert.ok(FN_START >= 0, 'maybeAutoArchiveHistory not found');
const FN_END = SRC.indexOf('\nfunction appendToFile(', FN_START);
assert.ok(FN_END > FN_START, 'appendToFile boundary not found');
const FN_SRC = SRC.slice(FN_START, FN_END).trim();

// Extract parseConversationContext source for backward-compat reader test.
const PARSE_START = SRC.indexOf('function parseConversationContext(');
assert.ok(PARSE_START >= 0, 'parseConversationContext not found');
// Find next top-level function after parseConversationContext.
const PARSE_END = SRC.indexOf('\nfunction buildHistorySelfLookupBlock(', PARSE_START);
assert.ok(PARSE_END > PARSE_START, 'buildHistorySelfLookupBlock boundary not found');
const PARSE_SRC = SRC.slice(PARSE_START, PARSE_END).trim();

function makeTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-test-'));
  const filePath = path.join(dir, 'history.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, dir };
}

function buildArchiveFn(threshold) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs', 'path', 'log', 'config', 'HISTORY_ARCHIVE_CLEAR_MARKER',
    'DEFAULT_HISTORY_ARCHIVE_THRESHOLD',
    `${FN_SRC}\n; return maybeAutoArchiveHistory;`
  );
  return factory(fs, path, () => {}, { 'history-archive-threshold-lines': threshold }, LIVE_MARKER, threshold);
}

const ANY_RESPONSE_HEADER = '(?:Coding Agent|Planning Agent|Parallel Coding Agent|Parallel Planning Agent)\\s+Response(?:\\s+\\(.*?\\))?';

function buildParseFn() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs', 'ANY_RESPONSE_HEADER',
    `${PARSE_SRC}; return parseConversationContext;`
  );
  return factory(fs, ANY_RESPONSE_HEADER);
}

describe('history-archive-marker-not-frontmatter', () => {
  // (a) First line of the file written by maybeAutoArchiveHistory must NOT be '---'.
  test('new marker never renders as frontmatter', () => {
    assert.ok(
      !LIVE_MARKER.startsWith('---'),
      `HISTORY_ARCHIVE_CLEAR_MARKER starts with '---' which renders as YAML front-matter: ${JSON.stringify(LIVE_MARKER)}`
    );
    assert.strictEqual(
      LIVE_MARKER,
      '<!-- CLEAR CONTEXT -->',
      `Expected HTML comment marker, got: ${JSON.stringify(LIVE_MARKER)}`
    );

    // Actually write a file and verify the first line.
    const threshold = 3;
    const archiveFn = buildArchiveFn(threshold);
    const bigContent = 'line\n'.repeat(threshold + 1);
    const { filePath } = makeTmpFile(bigContent);

    archiveFn(filePath);

    const written = fs.readFileSync(filePath, 'utf8');
    const firstLine = written.split('\n')[0];
    assert.notStrictEqual(firstLine, '---', `First line of archived file must not be '---' (YAML front-matter trigger)`);
  });

  // (b) No YAML frontmatter block (---\n...\n---) parseable at file head after archive.
  test('archived file has no parseable YAML frontmatter block', () => {
    const threshold = 3;
    const archiveFn = buildArchiveFn(threshold);
    const bigContent = 'line\n'.repeat(threshold + 1);
    const { filePath } = makeTmpFile(bigContent);

    archiveFn(filePath);

    const written = fs.readFileSync(filePath, 'utf8');
    // YAML frontmatter: file starts with '---\n' and has a closing '---' line.
    const hasFrontmatter = /^---\n[\s\S]*?\n---/m.test(written) && written.startsWith('---\n');
    assert.ok(!hasFrontmatter, 'Archived file must not start with a parseable YAML front-matter block');
  });

  // (c) Old-marker fixture (`--- CLEAR CONTEXT ---`) still slices correctly via backward-compat reader.
  test('old marker fixture still slices correctly via backward-compat reader', () => {
    const parseFn = buildParseFn();
    const oldMarker = '--- CLEAR CONTEXT ---';

    // Build a history file where the old marker appears mid-file, followed by a valid prompt block.
    const fixture = [
      '## User Prompt\n\nstale content',
      '',
      oldMarker,
      '',
      '## User Prompt\n\nfresh prompt content',
      '',
      '## Coding Agent Response\n\nsome response',
    ].join('\n');

    const { filePath } = makeTmpFile(fixture);
    const result = parseFn(filePath);

    assert.ok(result !== null, 'parseConversationContext should not return null for old-marker fixture');
    assert.ok(!result.includes('stale content'), 'Content before old marker must be excluded');
    assert.ok(result.includes('fresh prompt content'), 'Content after old marker must be included');
  });
});
