#!/usr/bin/env node
'use strict';

/**
 * Regression: when the seed `# Prompt Queue` block is followed directly by a
 * user prompt with NO `---` divider, the merged block must not be discarded.
 * Seed prefix is stripped, residual user content is kept as a real prompt.
 *
 * Run: node Agent_Orchestrator/tests/queue-seed-merged-with-prompt.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const promptQueue = require(path.join(HARNESS, 'src', 'prompt-queue.js'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pq-seedmerge-')); }
function writeQueue(dir, txt) { fs.writeFileSync(path.join(dir, 'prompt-queue.md'), txt, 'utf8'); }

// Build a seed-shaped block (heading + HTML comment) so `SEED_PREFIX_RE` matches.
const SEED = [
  '# Prompt Queue',
  '',
  '<!--',
  'Queued prompts run automatically after the current pipeline finishes.',
  'FORMAT: separate blocks with a line containing only `---`.',
  '-->',
].join('\n');

test('(S1) seed merged with first prompt (no divider) — first prompt is recovered', () => {
  const d = tmpdir();
  // Seed has NO trailing `---`. A real prompt appended directly. Then `---`
  // and a (hold) prompt.
  const txt =
    SEED + '\n' +
    'Pipeline: caf\n' +
    'Recovered first prompt body.\n' +
    '\n---\n\n' +
    'Pipeline: caf (hold)\n' +
    'Held second prompt.\n';
  writeQueue(d, txt);

  assert.strictEqual(promptQueue.queueLength(d), 2,
    'queueLength should see 2 blocks (recovered + held)');

  const res = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(res && res.block, 'recovered block must dispatch — not all-held');
  assert.notStrictEqual(res.warning, 'all-held');
  assert.strictEqual(res.block.pipeline, 'caf');
  assert.ok(res.block.body.includes('Recovered first prompt body.'),
    `body should contain recovered prompt, got: ${JSON.stringify(res.block.body)}`);
});

test('(S2) pure seed block (no user content appended) still drops cleanly', () => {
  const d = tmpdir();
  writeQueue(d, SEED + '\n');
  assert.strictEqual(promptQueue.queueLength(d), 0,
    'pure seed-only file should produce 0 blocks');
});

test('(S3) properly-divided seed + prompt still parses as 1 block (no regression)', () => {
  const d = tmpdir();
  const txt = SEED + '\n\n---\n\nPipeline: caf\nNormal first prompt.\n';
  writeQueue(d, txt);
  assert.strictEqual(promptQueue.queueLength(d), 1);
  const res = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(res && res.block);
  assert.ok(res.block.body.includes('Normal first prompt.'));
});

if (_failed) process.exit(1);
