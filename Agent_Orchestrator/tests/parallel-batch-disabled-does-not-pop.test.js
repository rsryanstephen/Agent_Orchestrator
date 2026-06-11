#!/usr/bin/env node
'use strict';

/**
 * Regression: when `run-queue-in-parallel` is false, `_maybeRunParallelQueueBatch`
 * must return false BEFORE touching the queue (no `dequeueFirstUnheld` call), and
 * must also return false (without popping anything) when fewer than 2 non-hold
 * blocks are present. Guards the stub-runner-eats-blocks failure mode where the
 * parallel branch silently drains queued prompts into `.parallel/<slug>.md`.
 *
 * Source-level grep tests in the style of queue-drain-after-clarify-pause.test.js.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Locate the `_maybeRunParallelQueueBatch` function body.
function extractParallelFn() {
  const start = runAgentSrc.indexOf('async function _maybeRunParallelQueueBatch');
  assert.ok(start > 0, 'must find _maybeRunParallelQueueBatch');
  // End at the next top-level `async function ` / `function ` declaration.
  const after = runAgentSrc.slice(start + 1);
  const nextFn = after.search(/\nasync function |\nfunction /);
  assert.ok(nextFn > 0, 'must find end of _maybeRunParallelQueueBatch');
  return runAgentSrc.slice(start, start + 1 + nextFn);
}

test('disabled flag short-circuits BEFORE any dequeue', () => {
  const fn = extractParallelFn();
  // The `if (!enabled) return false;` must occur before the first `dequeueFirstUnheld` call.
  const guardIdx = fn.search(/if \(!enabled\) return false;/);
  const dequeueIdx = fn.indexOf('dequeueFirstUnheld');
  assert.ok(guardIdx > 0, 'must short-circuit on !enabled');
  assert.ok(dequeueIdx > 0, 'must reference dequeueFirstUnheld');
  assert.ok(guardIdx < dequeueIdx, '!enabled guard must precede any dequeue');
});

test('nonHold<2 short-circuits BEFORE the drain loop dequeue', () => {
  const fn = extractParallelFn();
  const lt2Idx = fn.search(/if \(nonHold\.length < 2\) return false;/);
  // The drain `for` loop is what calls dequeueFirstUnheld repeatedly.
  const loopIdx = fn.indexOf('for (let i = 0; i < nonHold.length; i++)');
  assert.ok(lt2Idx > 0, 'must short-circuit when nonHold.length < 2');
  assert.ok(loopIdx > 0, 'must contain drain loop');
  assert.ok(lt2Idx < loopIdx, 'nonHold<2 guard must precede drain loop');
});

test('forensic trace records enabled flag + nonHold count for post-mortem', () => {
  const fn = extractParallelFn();
  assert.ok(/appendAutoResumeLog\(`_maybeRunParallelQueueBatch: topic="\$\{topic\}" enabled=/.test(fn),
    'must trace enabled flag at entry');
  assert.ok(/appendAutoResumeLog\(`_maybeRunParallelQueueBatch: nonHold=/.test(fn),
    'must trace nonHold count after partition');
});

test('drain loop logs each pop body-head for post-mortem', () => {
  const fn = extractParallelFn();
  assert.ok(/appendAutoResumeLog\(`dequeueFirstUnheld\[parallelBatch#\$\{i\}\]/.test(fn),
    'each drain-loop pop must be traced with body-head');
});

test('STUB-GUARD blocks drain when enabled=true but parallel-runner-implemented=false', () => {
  const fn = extractParallelFn();
  // The new guard must (a) read `parallel-runner-implemented`, (b) early-return
  // false BEFORE the drain loop, (c) emit a forensic trace identifying itself.
  const cfgReadIdx = fn.search(/cfgRead\([^)]*'parallel-runner-implemented'/);
  const guardIdx = fn.search(/if \(!runnerImpl\) \{/);
  const loopIdx = fn.indexOf('for (let i = 0; i < nonHold.length; i++)');
  const traceIdx = fn.search(/STUB-GUARD active/);
  assert.ok(cfgReadIdx > 0, 'must read parallel-runner-implemented config');
  assert.ok(guardIdx > 0, 'must early-return when runnerImpl is false');
  assert.ok(traceIdx > 0, 'must emit STUB-GUARD forensic trace');
  assert.ok(guardIdx < loopIdx, 'runnerImpl guard must precede drain loop');
  assert.ok(/return false;/.test(fn.slice(guardIdx, guardIdx + 800)),
    'runnerImpl guard must return false (no drain)');
});
