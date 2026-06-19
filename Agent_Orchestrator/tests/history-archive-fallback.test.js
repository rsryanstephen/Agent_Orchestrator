'use strict';

/**
 * Regression tests for buildHistoryPreamble + findLatestArchive + extractRecentResponses.
 *
 * Covers the post-auto-archive fallback path: when the active history file is
 * a stub (`<!-- CLEAR CONTEXT -->` + empty `## User Prompt`), the preamble
 * builder must read prior agent responses from the newest archive sibling.
 *
 * Run: node --test Agent_Orchestrator/tests/history-archive-fallback.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test } = require('node:test');

const RUN_AGENT_PATH = path.join(__dirname, '..', 'src', 'run-agent.js');
const SRC = fs.readFileSync(RUN_AGENT_PATH, 'utf8');

// Pull function bodies out of run-agent.js and rebuild them with injected
// `historyPath` + `fs` + `path` so we can exercise them without booting the
// whole harness.
function extractFn(name, terminator) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = SRC.indexOf(terminator, start);
  assert.ok(end > start, `terminator for ${name} not found`);
  return SRC.slice(start, end).trim();
}

const FIND_ARCHIVE_SRC = extractFn('findLatestArchive', '\n// Shared response extractor');
const EXTRACT_SRC = extractFn('extractRecentResponses', '\n// Reconstructs prior-run agent responses');
const BUILD_SRC = extractFn('buildHistoryPreamble', '\n// ── Claude runner');

const ANY_RESPONSE_HEADER = '(?:Planning|Coding|Assessment)\\s+Agent(?:\\s+\\d+)?\\s+Response(?:\\s*\\(Remediation(?:\\s+task-\\d+)?\\))?(?:\\s*\\(task-\\d+\\))?';

function buildPreamble(historyPath) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fs', 'path', 'historyPath', 'ANY_RESPONSE_HEADER',
    `${FIND_ARCHIVE_SRC}\n${EXTRACT_SRC}\n${BUILD_SRC}\n; return buildHistoryPreamble;`
  );
  return factory(fs, path, historyPath, ANY_RESPONSE_HEADER)();
}

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-fallback-'));
  return { dir, historyPath: path.join(dir, 'topic.md') };
}

function archiveBody(responses) {
  // Simulated pre-rotation history with N response blocks then a trailing prompt.
  return responses.map((r, i) =>
    `## Coding Agent Response\n\n${r}\n\n*Model: test*\n`
  ).join('\n---\n') + '\n## User Prompt\n';
}

// ---------------------------------------------------------------------------

test('fallback: post-archive stub history reads responses from newest archive', () => {
  const { dir, historyPath } = makeTmp();
  fs.writeFileSync(historyPath, '<!-- CLEAR CONTEXT -->\n\n## User Prompt\n', 'utf8');
  const archivePath = path.join(dir, 'topic.archive-2026-06-12T17-00-07.md');
  fs.writeFileSync(archivePath, archiveBody(['first body', 'second body', 'third body']), 'utf8');

  const preamble = buildPreamble(historyPath);
  assert.ok(preamble.includes('Prior Session Context'), 'preamble must be present');
  assert.ok(preamble.includes('from archive topic.archive-2026-06-12T17-00-07.md'), 'preamble must note archive source');
  assert.ok(preamble.includes('third body'), 'most recent archive response must be included');

  fs.rmSync(dir, { recursive: true });
});

test('no double-injection: when active history already has responses, archive is NOT consulted', () => {
  const { dir, historyPath } = makeTmp();
  fs.writeFileSync(historyPath,
    `## Coding Agent Response\n\nlive body\n\n## User Prompt\n`, 'utf8');
  const archivePath = path.join(dir, 'topic.archive-2026-06-12T17-00-07.md');
  fs.writeFileSync(archivePath, archiveBody(['archived body']), 'utf8');

  const preamble = buildPreamble(historyPath);
  assert.ok(preamble.includes('live body'), 'live response must be included');
  assert.ok(!preamble.includes('archived body'), 'archive must NOT be consulted when live has responses');
  assert.ok(!preamble.includes('from archive'), 'archive note must not appear when fallback was not used');

  fs.rmSync(dir, { recursive: true });
});

test('graceful: no archive files exist returns empty string', () => {
  const { dir, historyPath } = makeTmp();
  fs.writeFileSync(historyPath, '<!-- CLEAR CONTEXT -->\n\n## User Prompt\n', 'utf8');

  const preamble = buildPreamble(historyPath);
  assert.strictEqual(preamble, '', 'must return empty string when stub + no archives');

  fs.rmSync(dir, { recursive: true });
});

// Adjacent-headers fixture: pins the externally observable behavior of the
// `+?` lazy-body capture in `extractRecentResponses`. With `+?` (vs the prior
// `*?`) a zero-body header CANNOT match a zero-length body — instead the
// lazy quantifier expands until the NEXT response header on its own line,
// which means an empty-body leading header is absorbed into the next match's
// body. Net effect: the real body content survives and is captured; the
// preamble simply echoes the leading header inside the body text. This test
// locks in that behavior so future regex tweaks cannot silently change it.
test('adjacent response headers: real body survives even when preceded by empty-body header', () => {
  const { dir, historyPath } = makeTmp();
  fs.writeFileSync(historyPath, '<!-- CLEAR CONTEXT -->\n\n## User Prompt\n', 'utf8');
  const archivePath = path.join(dir, 'topic.archive-2026-06-12T17-00-07.md');
  // Two response headers back-to-back (no body between them), then a real body.
  const archive =
    `## Coding Agent Response\n` +
    `## Coding Agent Response\n\nreal body here\n\n*Model: test*\n\n## User Prompt\n`;
  fs.writeFileSync(archivePath, archive, 'utf8');

  const preamble = buildPreamble(historyPath);
  assert.ok(preamble.includes('real body here'), 'non-empty body must be captured');
  assert.ok(preamble.includes('Prior Session Context'), 'preamble wrapper must be present');
  // `*Model: test*` footer is stripped during extract; confirm.
  assert.ok(!preamble.includes('*Model: test*'), 'usage footer must be stripped');

  fs.rmSync(dir, { recursive: true });
});

test('archive ordering: newest ISO timestamp wins regardless of mtime', () => {
  const { dir, historyPath } = makeTmp();
  fs.writeFileSync(historyPath, '<!-- CLEAR CONTEXT -->\n\n## User Prompt\n', 'utf8');
  // Write the OLDER archive last (so mtime ordering would pick it) — filename
  // timestamp must still drive selection.
  const newer = path.join(dir, 'topic.archive-2026-06-12T18-00-00.md');
  const older = path.join(dir, 'topic.archive-2026-06-12T10-00-00.md');
  fs.writeFileSync(newer, archiveBody(['newer body']), 'utf8');
  fs.writeFileSync(older, archiveBody(['older body']), 'utf8');

  const preamble = buildPreamble(historyPath);
  assert.ok(preamble.includes('newer body'), 'must pick archive with newest filename timestamp');
  assert.ok(!preamble.includes('older body'), 'older archive must not be consulted');

  fs.rmSync(dir, { recursive: true });
});
