#!/usr/bin/env node
'use strict';

// Regression: every history append in lib/parallel-batch.js must hold a
// cross-process PID file lock (`historyPath + '.lock'`) around the write, so
// multiple run-agent.js processes appending concurrently cannot tear each
// other's output. Behavioral — stub fs.appendFileSync to assert the lock file
// exists at the instant of every append.
//
// Run: node Agent_Orchestrator/tests/parallel-batch-append-uses-filelock.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const batch = require('../src/lib/parallel-batch');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, '\n', e.stack || e.message); }
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-lock-'));
  return d;
}

// Wrap fs.appendFileSync to record, per call, whether the lock file was present.
function withAppendSpy(historyPath, run) {
  const real = fs.appendFileSync;
  const lockSeen = [];
  fs.appendFileSync = function (p, data, enc) {
    if (p === historyPath) lockSeen.push(fs.existsSync(historyPath + '.lock'));
    return real.call(fs, p, data, enc);
  };
  try { run(); } finally { fs.appendFileSync = real; }
  return lockSeen;
}

test('spliceStagingSync holds the .lock around the history append', () => {
  const dir = tmpDir();
  const historyPath = path.join(dir, 'history.md');
  fs.writeFileSync(historyPath, '# history\n', 'utf8');
  batch.writeStagingPrompt(dir, 0, 'task', 'a prompt body');
  batch.markStagingComplete(dir, 0, 'task', 'agent output');
  const seen = withAppendSpy(historyPath, () => {
    batch.spliceStagingSync(historyPath, dir, { next: 0 });
  });
  assert.strictEqual(seen.length, 1, 'exactly one history append expected');
  assert.ok(seen.every(Boolean), 'lock file must exist during every append');
  // Lock released after the splice completes.
  assert.ok(!fs.existsSync(historyPath + '.lock'), 'lock must be released');
  assert.ok(fs.readFileSync(historyPath, 'utf8').includes('agent output'));
});

test('recoverStagingOrphans holds the .lock around the recovery append', () => {
  const dir = tmpDir();
  const historyPath = path.join(dir, 'history.md');
  const queuePath = path.join(dir, 'prompt-queue.md');
  fs.writeFileSync(historyPath, '# history\n', 'utf8');
  batch.writeStagingPrompt(dir, 0, 'task', 'orphan body');
  batch.markStagingComplete(dir, 0, 'task', 'recovered output');
  const seen = withAppendSpy(historyPath, () => {
    batch.recoverStagingOrphans(dir, historyPath, queuePath);
  });
  assert.strictEqual(seen.length, 1, 'exactly one recovery append expected');
  assert.ok(seen.every(Boolean), 'lock file must exist during the recovery append');
  assert.ok(!fs.existsSync(historyPath + '.lock'), 'lock must be released');
});

async function asyncTest(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, '\n', e.stack || e.message); }
}

(async () => {
  await asyncTest('appendConsolidated holds the .lock around the consolidated append', async () => {
    const dir = tmpDir();
    const historyPath = path.join(dir, 'history.md');
    fs.writeFileSync(historyPath, '# history\n', 'utf8');
    const seen = [];
    const real = fs.appendFileSync;
    fs.appendFileSync = function (p, data, enc) {
      if (p === historyPath) seen.push(fs.existsSync(historyPath + '.lock'));
      return real.call(fs, p, data, enc);
    };
    try { await batch.appendConsolidated(historyPath, '## Parallel Batch x\n\nbody'); }
    finally { fs.appendFileSync = real; }
    assert.strictEqual(seen.length, 1, 'exactly one consolidated append expected');
    assert.ok(seen.every(Boolean), 'lock file must exist during the consolidated append');
    assert.ok(!fs.existsSync(historyPath + '.lock'), 'lock must be released');
  });
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
