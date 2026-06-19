#!/usr/bin/env node
'use strict';

// Behavioral tests for two parallel-config keys lacking dedicated coverage:
//   - `max-parallel-agents`     -> parallel-semaphore cap + process-wide singleton
//   - `run-queue-in-parallel`   -> partitionBlocks hold-exclusion (FIFO non-hold batch)
// Run: node Agent_Orchestrator/tests/parallel-semaphore-and-queue-partition.test.js

const assert = require('assert');
const semaphore = require('../src/lib/parallel-semaphore');
const parallelBatch = require('../src/lib/parallel-batch');

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log('PASS', name))
    .catch(e => { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; });
}

// max-parallel-agents: cap enforced — never more than N in flight at once.
test('createSemaphore caps concurrent holders at N', async () => {
  const sem = semaphore.createSemaphore(2);
  let inFlight = 0, peak = 0;
  const work = async () => {
    const release = await sem.acquire('t/slug');
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--; release();
  };
  await Promise.all(Array.from({ length: 6 }, work));
  assert.strictEqual(peak, 2, 'peak concurrency must equal cap');
});

// Description claims a single shared semaphore "across all topics". Within ONE
// process getSemaphore returns the SAME instance (first cap wins) — this is the
// only mechanism backing the "shared" claim.
test('getSemaphore is a process-wide singleton (first cap wins)', () => {
  semaphore._resetForTests();
  const a = semaphore.getSemaphore(3);
  const b = semaphore.getSemaphore(9);
  assert.strictEqual(a, b, 'same instance returned');
  assert.strictEqual(a.capacity, 3, 'first cap wins; later cap ignored');
  semaphore._resetForTests();
});

// run-queue-in-parallel: non-hold blocks form the FIFO batch; (hold) blocks are
// excluded and returned untouched for the sequential path.
test('partitionBlocks excludes (hold) blocks from the parallel batch', () => {
  const blocks = [
    { body: 'a', held: false },
    { body: 'b', held: true },
    { body: 'c', held: false },
  ];
  const { parallel, hold } = parallelBatch.partitionBlocks(blocks);
  assert.deepStrictEqual(parallel.map(b => b.body), ['a', 'c'], 'only non-hold dispatched');
  assert.deepStrictEqual(hold.map(b => b.body), ['b'], 'hold blocks held back');
  // queueIndex preserved for deterministic FIFO consolidation.
  assert.deepStrictEqual(parallel.map(b => b.queueIndex), [0, 2]);
});
