#!/usr/bin/env node
/**
 * Regression tests: confirms the compression code path is fully gone.
 *
 *  (1) src/compress-memory.js no longer exists
 *  (2) src/run-agent.js does not reference compressTopic / summarizeContent /
 *      __compress-history__ / max-history-lines / `## Compressed Memory`
 *  (3) src/run-agent.js does not require ./compress-memory
 *  (4) maybeAutoArchiveHistory's archive content does not include
 *      `## Compressed Memory`
 *  (5) scrub-compressed-memory.js correctly strips legacy sections
 *  (6) normalize-history.js does not re-inject the Compressed Memory header
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { _failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

test('(1) src/compress-memory.js is removed', () => {
  assert.ok(!fs.existsSync(path.join(HARNESS, 'src', 'compress-memory.js')),
    'compress-memory.js must not exist anymore');
});

test('(2) run-agent.js does not reference compression hooks', () => {
  for (const needle of [
    'compressTopic',
    'summarizeContent',
    "'__compress-history__'",
    "config['max-history-lines']",
    '_pendingHistoryCompress',
    '_enqueueHistoryCompress',
    '_checkHistoryLineLimit',
  ]) {
    assert.ok(!RUN_AGENT_SRC.includes(needle),
      `run-agent.js must not contain "${needle}"`);
  }
});

test('(3) run-agent.js does not require ./compress-memory', () => {
  assert.ok(!/require\(['"]\.\/compress-memory['"]\)/.test(RUN_AGENT_SRC),
    'run-agent.js must not require ./compress-memory');
});

test('(4) maybeAutoArchiveHistory does not inject `## Compressed Memory`', () => {
  // The function must still exist, but its body must not emit a Compressed Memory header.
  assert.ok(/async function maybeAutoArchiveHistory\b/.test(RUN_AGENT_SRC),
    'maybeAutoArchiveHistory must still exist');
  // Coarse but sufficient: no string-literal or template-literal injection of the header.
  const offenders = [
    '## Compressed Memory\\n',
    '`## Compressed Memory',
    "'## Compressed Memory",
    '"## Compressed Memory',
  ];
  for (const needle of offenders) {
    assert.ok(!RUN_AGENT_SRC.includes(needle),
      `run-agent.js must not contain header-injection literal "${needle}"`);
  }
});

test('(5) scrub-compressed-memory strips legacy sections', () => {
  const { stripCompressedSections } = require(path.join(HARNESS, 'src', 'scrub-compressed-memory.js'));
  const input = [
    '## User Prompt',
    '',
    'Do thing.',
    '',
    '---',
    '',
    '## Coding Agent Response (Compressed Memory)',
    '',
    'Stale summary content.',
    '',
    '---',
    '',
    '## Compressed Memory',
    '',
    'Another stale block.',
    '',
    '---',
    '',
    '## Coding Agent Response',
    '',
    'Real content.',
    '',
  ].join('\n');
  const { out, removed } = stripCompressedSections(input);
  assert.strictEqual(removed, 2, 'must strip both legacy sections');
  assert.ok(!out.includes('Compressed Memory'), 'no Compressed Memory text may remain');
  assert.ok(out.includes('Real content.'), 'live sections must survive');
});

test('(6) normalize-history.js does not re-inject Compressed Memory', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'normalize-history.js'), 'utf8');
  assert.ok(!/Compressed Memory/.test(src),
    'normalize-history.js must not reference Compressed Memory');
});

if (_failed === 0) console.log('\nAll no-compressed-memory-injection tests passed.');
else { console.error(`\n${_failed} test(s) FAILED.`); process.exit(1); }
