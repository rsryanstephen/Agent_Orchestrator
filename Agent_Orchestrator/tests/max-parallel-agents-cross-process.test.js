#!/usr/bin/env node
'use strict';

// Behavioral test for `max-parallel-agents` (QA FAIL #2 — was per-process only).
// Verifies the cross-process counting semaphore: cap enforcement, blocking +
// release, stale-slot reaping, and a genuine MULTI-PROCESS cap where 4 child
// processes contend on one slotsDir at cap=2 and never overlap >2 at once.
// Run: node Agent_Orchestrator/tests/max-parallel-agents-cross-process.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const semaphore = require('../src/lib/parallel-semaphore');

function test(name, fn) {
  Promise.resolve().then(fn)
    .then(() => console.log('PASS', name))
    .catch(e => { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; });
}
function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mpa-')); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('cross-process semaphore caps holders, blocks, releases', async () => {
  const tmp = mkTmp();
  const slots = path.join(tmp, 'slots');
  const sem = semaphore.createCrossProcessSemaphore(2, slots);
  const r1 = await sem.acquire('a');
  const r2 = await sem.acquire('b');
  assert.strictEqual(sem.inUse, 2, 'two slots held');

  let third = false;
  const p3 = sem.acquire('c').then(rel => { third = true; return rel; });
  await sleep(150);
  assert.strictEqual(third, false, 'third acquire blocks at cap');

  r1();
  const r3 = await p3;
  assert.strictEqual(third, true, 'third acquire resolves after a release');
  r2(); r3();
  assert.strictEqual(sem.inUse, 0, 'all released');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('stale slot from a dead PID is reaped', async () => {
  const tmp = mkTmp();
  const slots = path.join(tmp, 'slots');
  fs.mkdirSync(slots, { recursive: true });
  // A PID that is virtually certain not to exist.
  fs.writeFileSync(path.join(slots, '2147483646.0.slot'), 'dead', 'utf8');
  const sem = semaphore.createCrossProcessSemaphore(1, slots);
  const rel = await sem.acquire('live'); // must succeed by reaping the dead slot
  assert.strictEqual(sem.inUse, 1, 'only the live slot counts; dead one reaped');
  rel();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('4 processes at cap=2 never overlap more than 2', async () => {
  const tmp = mkTmp();
  const slots = path.join(tmp, 'slots');
  const results = path.join(tmp, 'intervals.log');
  fs.writeFileSync(results, '', 'utf8');
  const semPath = path.join(__dirname, '..', 'src', 'lib', 'parallel-semaphore.js');
  const childSrc = path.join(tmp, 'acq.js');
  fs.writeFileSync(childSrc, [
    "const fs=require('fs');",
    `const sem=require(${JSON.stringify(semPath)});`,
    `const slots=${JSON.stringify(slots)};`,
    `const results=${JSON.stringify(results)};`,
    "(async()=>{",
    "  const s=sem.createCrossProcessSemaphore(2, slots);",
    "  const rel=await s.acquire('p'+process.pid);",
    "  const start=Date.now();",
    "  await new Promise(r=>setTimeout(r,250));",
    "  const end=Date.now();",
    "  rel();",
    "  fs.appendFileSync(results, JSON.stringify([start,end])+'\\n');",
    "})();",
  ].join('\n'), 'utf8');

  // Launch 4 children concurrently.
  const procs = Array.from({ length: 4 }, () =>
    require('child_process').spawn(process.execPath, [childSrc], { stdio: 'ignore' }));
  await Promise.all(procs.map(p => new Promise(res => p.on('exit', res))));

  const intervals = fs.readFileSync(results, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(intervals.length, 4, 'all 4 children recorded an interval');
  // Compute max concurrent overlap.
  const events = [];
  for (const [s, e] of intervals) { events.push([s, 1]); events.push([e, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of events) { cur += d; peak = Math.max(peak, cur); }
  assert.ok(peak <= 2, `peak cross-process concurrency ${peak} must be <= cap 2`);
  fs.rmSync(tmp, { recursive: true, force: true });
});
