#!/usr/bin/env node
'use strict';

// Behavioral test for `parallel-stale-sweep-hours` -> sweepStaleParallelDirs.
// Verifies dirs older than the threshold are removed and fresh ones survive.
// Run: node Agent_Orchestrator/tests/parallel-stale-sweep-age-threshold.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const parallelBatch = require('../src/lib/parallel-batch');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('sweepStaleParallelDirs removes dirs older than staleHours, keeps fresh', () => {
  const topicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const root = path.join(topicDir, '.parallel');
  const stale = path.join(root, 'old-0');
  const fresh = path.join(root, 'new-1');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });

  const now = 1_000_000_000_000;
  const hour = 3600 * 1000;
  // stale: 13h old (> 12h threshold). fresh: 1h old.
  fs.utimesSync(stale, new Date(now - 13 * hour), new Date(now - 13 * hour));
  fs.utimesSync(fresh, new Date(now - 1 * hour), new Date(now - 1 * hour));

  const removed = parallelBatch.sweepStaleParallelDirs(topicDir, 12, now);

  assert.ok(removed.some(p => p.endsWith('old-0')), 'stale dir should be reported removed');
  assert.strictEqual(fs.existsSync(stale), false, 'stale dir gone');
  assert.strictEqual(fs.existsSync(fresh), true, 'fresh dir kept');

  fs.rmSync(topicDir, { recursive: true, force: true });
});

test('no .parallel root -> no-op, returns empty', () => {
  const topicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  assert.deepStrictEqual(parallelBatch.sweepStaleParallelDirs(topicDir, 12, 1_000_000_000_000), []);
  fs.rmSync(topicDir, { recursive: true, force: true });
});
