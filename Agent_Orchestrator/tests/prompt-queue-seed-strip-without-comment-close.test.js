'use strict';

/**
 * Regression tests for seed-block stripping when --> is absent.
 *
 * Run: node --test Agent_Orchestrator/tests/prompt-queue-seed-strip-without-comment-close.test.js
 */

const assert = require('assert');
const { test } = require('node:test');
const path = require('path');
const fs = require('fs');

const QUEUE_MODULE_PATH = path.join(__dirname, '..', 'src', 'prompt-queue.js');

function freshModule() {
  delete require.cache[require.resolve(QUEUE_MODULE_PATH)];
  return require(QUEUE_MODULE_PATH);
}

// Returns parsed blocks by feeding rawText as if it were the queue file on disk.
function parseRaw(rawText) {
  const mod = freshModule();
  const origRead = fs.readFileSync;
  fs.readFileSync = (p, enc) => {
    if (typeof p === 'string' && p.endsWith('prompt-queue.md')) return rawText;
    return origRead(p, enc);
  };
  try {
    return mod.parseQueue('/fake/dir').blocks;
  } finally {
    fs.readFileSync = origRead;
  }
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

// Seed block as produced by buildSeedHeader() but WITHOUT the closing -->
const SEED_NO_CLOSE = [
  '# Prompt Queue',
  '',
  '<!--',
  'Queued prompts run automatically after the current pipeline finishes.',
  '',
  'FORMAT:',
  '  - Separate blocks with ---.',
  '',
  // intentionally omit -->
].join('\n');

// Seed block WITH proper --> close
const SEED_WITH_CLOSE = [
  '# Prompt Queue',
  '',
  '<!--',
  'Some instruction.',
  '-->',
  '',
].join('\n');

const USER_BODY = 'pcaf\nAdd the foo bar feature.';

// ── Case 1: seed missing --> is a standalone --- separated block ──────────────
//
// This is the observed bug (archive-2026-06-09T05-32-55.md:4544-4587): the
// seed block appears as a full `---`-separated block without `-->`. Without the
// fix the seed leaks as user content.
test('prompt-queue-seed-strip-without-comment-close > strips seed when --> missing', () => {
  const rawText = SEED_NO_CLOSE + '\n\n---\n\n' + USER_BODY;
  const blocks = parseRaw(rawText);
  assert.strictEqual(
    blocks.length, 1,
    `Expected 1 block, got ${blocks.length}: ${JSON.stringify(blocks.map(b => b.raw))}`
  );
  assert.ok(
    !blocks[0].raw.includes('# Prompt Queue'),
    'Seed heading must not appear in dequeued block'
  );
  assert.ok(
    blocks[0].body.includes('foo bar feature'),
    'User body must be preserved'
  );
});

// ── Case 2: heading-only block ────────────────────────────────────────────────
test('prompt-queue-seed-strip-without-comment-close > drops heading-only seed block', () => {
  const rawText = '# Prompt Queue\n\n---\n\n' + USER_BODY;
  const blocks = parseRaw(rawText);
  assert.strictEqual(
    blocks.length, 1,
    `Expected 1 block after heading-only seed, got ${blocks.length}`
  );
  assert.ok(
    blocks[0].body.includes('foo bar feature'),
    'User body must survive after heading-only seed is dropped'
  );
});

// ── Case 3: seed + user body merged without --- divider (with --> present) ────
//
// Existing SEED_PREFIX_RE (stage 1) must still recover this case.
test('prompt-queue-seed-strip-without-comment-close > strips seed when merged without --- divider', () => {
  const rawText = SEED_WITH_CLOSE + USER_BODY;
  const blocks = parseRaw(rawText);
  assert.strictEqual(
    blocks.length, 1,
    `Expected 1 recovered block, got ${blocks.length}`
  );
  assert.ok(
    blocks[0].body.includes('foo bar feature'),
    'User body must survive after stage-1 seed strip'
  );
  assert.ok(
    !blocks[0].raw.includes('# Prompt Queue'),
    'Seed heading must not appear in recovered block'
  );
});
