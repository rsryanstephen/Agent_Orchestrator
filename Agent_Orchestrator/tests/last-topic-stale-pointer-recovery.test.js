'use strict';

// Behavioral test for last-topic-guard: write a bogus topic name to a
// throw-away `.last-topic`, invoke the resolver against a temp topics dir,
// assert a valid fallback is chosen and the pointer file is rewritten.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { resolveLastTopic } = require('../src/lib/last-topic-guard');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ao-last-topic-'));
}

function setupTopicsDir(root, names) {
  const topicsDir = path.join(root, 'topic_files');
  fs.mkdirSync(topicsDir, { recursive: true });
  for (const n of names) fs.mkdirSync(path.join(topicsDir, n), { recursive: true });
  return topicsDir;
}

(function staleTopicRecovers() {
  const root = mktmp();
  const topicsDir = setupTopicsDir(root, ['claude_harness', 'other_topic']);
  const lastTopicPath = path.join(root, '.last-topic');
  fs.writeFileSync(lastTopicPath, '__stale_nonexistent__', 'utf8');

  const res = resolveLastTopic({ topicsDir, lastTopicPath, fallback: 'claude_harness' });
  assert.ok(res.topic, 'expected a recovered topic');
  assert.ok(['claude_harness', 'other_topic'].includes(res.topic), `unexpected fallback: ${res.topic}`);
  assert.strictEqual(res.recovered, true, 'recovered flag should be true');
  assert.match(res.reason || '', /stale/, 'reason should mention stale');
  const onDisk = fs.readFileSync(lastTopicPath, 'utf8').trim();
  assert.strictEqual(onDisk, res.topic, '.last-topic should be rewritten to recovered name');
  console.log('ok staleTopicRecovers');
})();

(function emptyPointerRecovers() {
  const root = mktmp();
  const topicsDir = setupTopicsDir(root, ['claude_harness']);
  const lastTopicPath = path.join(root, '.last-topic');
  fs.writeFileSync(lastTopicPath, '   ', 'utf8');

  const res = resolveLastTopic({ topicsDir, lastTopicPath, fallback: 'claude_harness' });
  assert.strictEqual(res.topic, 'claude_harness');
  assert.strictEqual(res.recovered, true);
  assert.match(res.reason || '', /empty/);
  console.log('ok emptyPointerRecovers');
})();

(function missingPointerRecovers() {
  const root = mktmp();
  const topicsDir = setupTopicsDir(root, ['claude_harness']);
  const lastTopicPath = path.join(root, '.last-topic');

  const res = resolveLastTopic({ topicsDir, lastTopicPath, fallback: 'claude_harness' });
  assert.strictEqual(res.topic, 'claude_harness');
  assert.strictEqual(res.recovered, true);
  assert.match(res.reason || '', /missing/);
  assert.strictEqual(fs.readFileSync(lastTopicPath, 'utf8').trim(), 'claude_harness');
  console.log('ok missingPointerRecovers');
})();

(function validPointerPassesThrough() {
  const root = mktmp();
  const topicsDir = setupTopicsDir(root, ['claude_harness', 'other_topic']);
  const lastTopicPath = path.join(root, '.last-topic');
  fs.writeFileSync(lastTopicPath, 'other_topic', 'utf8');

  const res = resolveLastTopic({ topicsDir, lastTopicPath, fallback: 'claude_harness' });
  assert.strictEqual(res.topic, 'other_topic');
  assert.strictEqual(res.recovered, false);
  assert.strictEqual(res.reason, null);
  console.log('ok validPointerPassesThrough');
})();

(function noTopicsAtAll() {
  const root = mktmp();
  setupTopicsDir(root, []);
  const topicsDir = path.join(root, 'topic_files');
  const lastTopicPath = path.join(root, '.last-topic');
  fs.writeFileSync(lastTopicPath, 'whatever', 'utf8');

  const res = resolveLastTopic({ topicsDir, lastTopicPath, fallback: 'claude_harness' });
  assert.strictEqual(res.topic, null);
  assert.strictEqual(res.recovered, false);
  assert.match(res.reason || '', /no fallback/);
  console.log('ok noTopicsAtAll');
})();

console.log('all last-topic-stale-pointer-recovery tests passed');
