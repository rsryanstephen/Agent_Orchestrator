#!/usr/bin/env node
/**
 * Regression: dequeueFirstUnheld must NOT pop a head block whose body looks
 * truncated (half-saved by an editor mid-flush). It returns
 * { block:null, warning:'truncated-held', remainingCount } and leaves the
 * block queued so the next drain (after the save lands) can process it whole.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const pq = require('../src/prompt-queue.js');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { _failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

function mkTopic() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-trunc-'));
  return dir;
}

function writeQueue(dir, body) {
  fs.writeFileSync(pq.queuePathFor(dir), body, 'utf8');
}

test('looksTruncated: odd fence count -> true', () => {
  assert.strictEqual(pq.looksTruncated && pq.looksTruncated('text\n```\ncode'), true);
});

test('looksTruncated: trailing colon -> true', () => {
  assert.strictEqual(pq.looksTruncated('The keys should be:'), true);
});

test('looksTruncated: unterminated inline backtick -> true', () => {
  assert.strictEqual(pq.looksTruncated('set `global-config.json'), true);
});

test('looksTruncated: balanced/complete body -> false', () => {
  assert.strictEqual(pq.looksTruncated('Fix the `auth` bug in the service.'), false);
  assert.strictEqual(pq.looksTruncated('text\n```\ncode\n```\ndone'), false);
});

test('colon-truncated head block is NOT dequeued and stays queued', () => {
  const dir = mkTopic();
  writeQueue(dir,
    '# Prompt Queue\n\n---\n\n' +
    'Make the sound per notification configurable via `global-config.json` keys, with defaults as fallbacks. The keys should be:\n');
  const res = pq.dequeueFirstUnheld(dir, { defaultPipeline: 'all', log: () => {} });
  assert.ok(res, 'expected a result object');
  assert.strictEqual(res.block, null, 'truncated head must not be popped');
  assert.strictEqual(res.warning, 'truncated-held', 'warning must be truncated-held');
  assert.ok(typeof res.remainingCount === 'number', 'remainingCount must be present');
  const after = pq.parseQueue(dir);
  assert.ok(after.blocks.length >= 1, 'block must remain in the queue');
  assert.ok(/The keys should be:/.test(after.blocks[0].body), 'original truncated body still queued');
});

test('fenced-truncated head block is NOT dequeued and stays queued', () => {
  const dir = mkTopic();
  writeQueue(dir,
    '# Prompt Queue\n\n---\n\n' +
    'Apply this patch:\n\n```diff\n+ const x = 1;\n');
  const res = pq.dequeueFirstUnheld(dir, { defaultPipeline: 'all', log: () => {} });
  assert.ok(res, 'expected a result object');
  assert.strictEqual(res.block, null, 'truncated (unterminated fence) head must not be popped');
  assert.strictEqual(res.warning, 'truncated-held');
  const after = pq.parseQueue(dir);
  assert.ok(after.blocks.length >= 1, 'block must remain in the queue');
});

test('release valve: benign colon head is released after MAX_TRUNCATION_HOLDS', () => {
  const dir = mkTopic();
  const QUEUE =
    '# Prompt Queue\n\n---\n\n' +
    'Refactor the parser. Steps to follow are:\n';
  let res = null;
  // Re-write the (unchanged) queue each drain to mimic repeated polls; the
  // body never changes, so the hold counter climbs and then releases.
  for (let i = 0; i < pq.MAX_TRUNCATION_HOLDS; i++) {
    writeQueue(dir, QUEUE);
    res = pq.dequeueFirstUnheld(dir, { defaultPipeline: 'all', log: () => {} });
  }
  assert.ok(res && res.block, 'block must be released on the Nth identical hold');
  assert.ok(/Steps to follow are:/.test(res.block.body), 'released body intact');
});

test('release valve: counter resets when truncated body changes', () => {
  const dir = mkTopic();
  writeQueue(dir, '# Prompt Queue\n\n---\n\nFirst draft ends in:\n');
  let res = pq.dequeueFirstUnheld(dir, { log: () => {} });
  assert.strictEqual(res.truncationHolds, 1, 'first hold counts 1');
  // Body changed (user kept typing) -> counter must reset, not accumulate.
  writeQueue(dir, '# Prompt Queue\n\n---\n\nA longer second draft ends in:\n');
  res = pq.dequeueFirstUnheld(dir, { log: () => {} });
  assert.strictEqual(res.truncationHolds, 1, 'changed body resets hold count to 1');
});

test('complete head block IS dequeued normally', () => {
  const dir = mkTopic();
  writeQueue(dir,
    '# Prompt Queue\n\n---\n\n' +
    'Fix the auth bug in the service.\n');
  const res = pq.dequeueFirstUnheld(dir, { defaultPipeline: 'all', log: () => {} });
  assert.ok(res && res.block, 'complete block must be popped');
  assert.ok(/Fix the auth bug/.test(res.block.body));
});

if (_failed) { console.error(`\n${_failed} test(s) failed`); process.exit(1); }
else console.log('\nAll tests passed');
