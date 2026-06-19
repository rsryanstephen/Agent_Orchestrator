#!/usr/bin/env node
'use strict';

/**
 * Public-surface regression test for parallel-broker.
 * Drives the broker exclusively through `createBroker({jobs,...}).start()`
 * with fake spawned children (EventEmitter + send/emit('exit')). Asserts
 * banner ordering, output prefixing, question routing, exit-code
 * aggregation, and chime behaviour. Zero access to `_state` / `_enqueue` /
 * other underscore hooks.
 *
 * Run: node Agent_Orchestrator/tests/parallel-broker-public-surface.test.js
 */

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const HARNESS = path.join(__dirname, '..');

// Intercept child_process.spawn BEFORE loading the broker so the broker's
// captured `spawn` reference returns our fake children.
const cp = require('child_process');
const fakeChildren = [];
cp.spawn = function fakeSpawn(cmd, args, opts) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.sent = [];
  c.killed = [];
  c.send = function (m) { this.sent.push(m); };
  c.kill = function (s) { this.killed.push(s); };
  c._spawnArgs = { cmd, args, opts };
  fakeChildren.push(c);
  return c;
};

// Stub provider registry so capability gate picks the parallel path
// deterministically regardless of global-config provider setting.
const registryPath = require.resolve(path.join(HARNESS, 'src', 'lib', 'providers', 'registry'));
require.cache[registryPath] = {
  id: registryPath,
  filename: registryPath,
  loaded: true,
  exports: { getProvider: () => ({ id: 'fake', capabilities: { subAgents: true } }) },
};

const { createBroker } = require(path.join(HARNESS, 'src', 'parallel-broker.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log(`  ok  ${name}`); },
    (err) => { failed++; console.error(`  FAIL ${name}\n       ${err && err.stack || err}`); }
  );
}

function bufStream() {
  const chunks = [];
  return { write: (c) => { chunks.push(String(c)); return true; }, value: () => chunks.join('') };
}

function makeStdin() {
  const s = new PassThrough();
  s.isTTY = false;
  return s;
}

function spin(jobs) {
  fakeChildren.length = 0;
  const stdout = bufStream();
  const stderr = bufStream();
  const stdin = makeStdin();
  const chimes = { n: 0 };
  const exits = [];
  const origExit = process.exit;
  process.exit = (c) => { exits.push(c); throw new Error('__exit__:' + c); };
  const broker = createBroker({
    runAgentPath: '/fake/run-agent.js',
    jobs,
    env: {},
    stdout,
    stderr,
    stdin,
    chime: () => { chimes.n++; },
  });
  try { broker.start(); } catch (_) { /* swallow start-time exits */ }
  return {
    broker, stdout, stderr, stdin, chimes, exits,
    children: fakeChildren.slice(),
    restoreExit: () => { process.exit = origExit; },
  };
}

async function main() {
  await test('start() prints launch banner naming every job token in order', () => {
    const ctx = spin([{ token: 'alpha', cmd: 'x' }, { token: 'beta', cmd: 'y' }]);
    try {
      assert.match(ctx.stdout.value(), /\[run-parallel\] Launching 2 job\(s\) via broker: alpha, beta/);
      assert.strictEqual(ctx.children.length, 2);
      assert.strictEqual(ctx.children[0]._spawnArgs.args[0], '/fake/run-agent.js');
    } finally { ctx.restoreExit(); }
  });

  await test('child stdout/stderr chunks are prefixed with [token] on the broker streams', () => {
    const ctx = spin([{ token: 'tok', cmd: 'c' }]);
    try {
      ctx.children[0].stdout.emit('data', 'hello\nworld\n');
      ctx.children[0].stderr.emit('data', 'oops\n');
      const out = ctx.stdout.value();
      assert.match(out, /\[tok\] hello/);
      assert.match(out, /\[tok\] world/);
      assert.match(ctx.stderr.value(), /\[tok\] oops/);
    } finally { ctx.restoreExit(); }
  });

  await test('question message: chime fires, banner prints, :submit routes answer via child.send', async () => {
    const ctx = spin([{ token: 'j1', cmd: 'c' }]);
    try {
      const child = ctx.children[0];
      child.emit('message', { type: 'question', topic: 'TopicX', role: 'planning', questionsText: 'Q1?' });
      // Non-TTY stdin path -> revealNext fires synchronously inside enqueue.
      assert.strictEqual(ctx.chimes.n, 1);
      assert.match(ctx.stdout.value(), /\[j1\] \(TopicX\) clarifying questions ready/);
      assert.match(ctx.stdout.value(), /──── \[j1\] \(TopicX\) clarifying questions ────/);
      ctx.stdin.write('my answer\n');
      ctx.stdin.write(':submit\n');
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(child.sent.length, 1);
      assert.deepStrictEqual(child.sent[0], { type: 'answer', text: 'my answer' });
    } finally { ctx.restoreExit(); }
  });

  await test('exit aggregation: any non-zero -> process.exit(1) with failure tally banner', () => {
    const ctx = spin([{ token: 'a', cmd: 'x' }, { token: 'b', cmd: 'y' }]);
    try {
      ctx.children[0].emit('exit', 0);
      assert.throws(() => ctx.children[1].emit('exit', 2), /__exit__:1/);
      assert.deepStrictEqual(ctx.exits, [1]);
      assert.match(ctx.stdout.value(), /All done\. 1 succeeded, 1 failed/);
      assert.match(ctx.stdout.value(), /\[a\] exited with code 0/);
      assert.match(ctx.stdout.value(), /\[b\] exited with code 2/);
    } finally { ctx.restoreExit(); }
  });

  await test('exit aggregation: all-zero -> process.exit(0) with success banner', () => {
    const ctx = spin([{ token: 'only', cmd: 'x' }]);
    try {
      assert.throws(() => ctx.children[0].emit('exit', 0), /__exit__:0/);
      assert.deepStrictEqual(ctx.exits, [0]);
      assert.match(ctx.stdout.value(), /All done\. 1 succeeded, 0 failed/);
    } finally { ctx.restoreExit(); }
  });

  await test('child exits while holding active prompt: queued head is announced next', () => {
    const ctx = spin([{ token: 'a', cmd: 'x' }, { token: 'b', cmd: 'y' }]);
    try {
      ctx.children[0].emit('message', { type: 'question', topic: 'A', questionsText: 'qa?' });
      ctx.children[1].emit('message', { type: 'question', topic: 'B', questionsText: 'qb?' });
      ctx.children[0].emit('exit', 0);
      assert.match(ctx.stderr.value(), /\[a\] child exited while awaiting answer/);
      assert.match(ctx.stdout.value(), /\[b\] \(B\) next clarifying questions queued/);
    } finally { ctx.restoreExit(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
