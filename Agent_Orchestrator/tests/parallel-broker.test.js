#!/usr/bin/env node
'use strict';

// Regression tests for parallel-broker.js. No real children are spawned; we
// inject fake EventEmitter "children" via the broker's _enqueue() hook and
// assert FIFO ordering, routing, exit-drop, sound suppression, and prefix
// formatting.
//
// Run: node Agent_Orchestrator/tests/parallel-broker.test.js

const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const HARNESS = path.join(__dirname, '..');
const { createBroker } = require(path.join(HARNESS, 'src', 'parallel-broker.js'));

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

function makeFakeChild() {
  const ch = new EventEmitter();
  ch.sent = [];
  ch.send = (msg) => { ch.sent.push(msg); return true; };
  ch.kill = () => {};
  ch.stdout = new EventEmitter();
  ch.stderr = new EventEmitter();
  return ch;
}

function makeOutSink() {
  const buf = [];
  return { write: (s) => buf.push(String(s)), buf, text: () => buf.join('') };
}

function makeBroker(jobs) {
  const stdout = makeOutSink();
  const stderr = makeOutSink();
  const chimeCalls = { count: 0 };
  const chime = () => { chimeCalls.count++; };
  const fakeStdin = new EventEmitter();
  fakeStdin.isTTY = false; // skip raw-mode arm; reveal immediately
  fakeStdin.resume = () => {};
  fakeStdin.setRawMode = () => {};
  fakeStdin.pause = () => {};
  const broker = createBroker({
    runAgentPath: 'unused',
    jobs,
    env: {},
    stdout,
    stderr,
    stdin: fakeStdin,
    chime,
    log: () => {},
  });
  return { broker, stdout, stderr, chimeCalls, fakeStdin };
}

// ── (a) FIFO order preserved when two children enqueue while one is active ────

test('FIFO: two children enqueueing in order → broker processes A then B', () => {
  const jobs = [{ token: '1-c', id: '1', cmd: 'coding' }, { token: '2-caf', id: '2', cmd: 'code-assess-fix' }];
  const { broker } = makeBroker(jobs);
  const childA = makeFakeChild();
  const childB = makeFakeChild();
  broker._enqueue({ token: '1-c', topic: 'alpha', role: 'planning', questionsText: 'Q-A', child: childA, job: jobs[0] });
  broker._enqueue({ token: '2-caf', topic: 'beta', role: 'planning', questionsText: 'Q-B', child: childB, job: jobs[1] });
  // Non-TTY stdin → reveal happens synchronously on first enqueue.
  // After first reveal, active should be A; B still queued.
  assert.ok(broker._state.active, 'expected an active entry after enqueue (non-TTY fast-path)');
  assert.strictEqual(broker._state.active.token, '1-c', 'A must be active first (FIFO)');
  assert.strictEqual(broker._state.pendingQuestions.length, 1, 'B must still be queued');
  assert.strictEqual(broker._state.pendingQuestions[0].token, '2-caf');
  // Submit A's answer → A receives, broker advances to B (non-TTY fast-path).
  broker._submitActive('answer-A');
  assert.deepStrictEqual(childA.sent[0], { type: 'answer', text: 'answer-A' }, 'A must receive its answer');
  assert.strictEqual(broker._state.active && broker._state.active.token, '2-caf',
    'after submitting A, B must become active (FIFO advance)');
});

// ── (b) Answer routing returns to correct child ──────────────────────────────

test('Answer routing: B\'s answer goes to child B (not A)', () => {
  const jobs = [{ token: '1-c', id: '1', cmd: 'coding' }, { token: '2-caf', id: '2', cmd: 'code-assess-fix' }];
  const { broker } = makeBroker(jobs);
  const childA = makeFakeChild();
  const childB = makeFakeChild();
  broker._enqueue({ token: '1-c', topic: 'alpha', role: 'planning', questionsText: 'Q-A', child: childA, job: jobs[0] });
  broker._enqueue({ token: '2-caf', topic: 'beta', role: 'planning', questionsText: 'Q-B', child: childB, job: jobs[1] });
  broker._submitActive('to-A'); // first reveal was A
  // Manually mark B active by enqueueing again is not needed — reveal of next happens.
  // Simulate broker auto-revealing next (non-TTY arm path):
  broker._state.pendingQuestions; // ensure ref exists
  // The broker's tryDispatchNext after submitActive arms keystroke reveal.
  // Under non-TTY stdin, armKeystrokeReveal calls revealNext synchronously.
  assert.strictEqual(broker._state.active && broker._state.active.token, '2-caf', 'B must now be active');
  broker._submitActive('to-B');
  assert.deepStrictEqual(childA.sent[0], { type: 'answer', text: 'to-A' });
  assert.deepStrictEqual(childB.sent[0], { type: 'answer', text: 'to-B' });
});

// ── (c) Child exit while queued → entry removed + warning logged ─────────────

test('Child exit while queued drops its question and warns', () => {
  const jobs = [
    { token: '1-c', id: '1', cmd: 'coding' },
    { token: '2-caf', id: '2', cmd: 'code-assess-fix' },
    { token: '3-p', id: '3', cmd: 'planning' },
  ];
  const { broker, stderr } = makeBroker(jobs);
  const childA = makeFakeChild();
  const childB = makeFakeChild();
  const childC = makeFakeChild();
  broker._enqueue({ token: '1-c', topic: 'alpha', role: 'planning', questionsText: 'Q-A', child: childA, job: jobs[0] });
  broker._enqueue({ token: '2-caf', topic: 'beta', role: 'planning', questionsText: 'Q-B', child: childB, job: jobs[1] });
  broker._enqueue({ token: '3-p', topic: 'gamma', role: 'planning', questionsText: 'Q-C', child: childC, job: jobs[2] });
  // Before submit: A active, B+C queued. Simulate B exiting mid-wait.
  // We can't call onChildExit fully (it eventually calls process.exit when all
  // exit codes recorded), but we can directly mutate the queue via the splice
  // semantics by calling the public _onChildExit on a job NOT in the jobs list
  // to avoid finalize(). Instead, call it but stub process.exit.
  const realExit = process.exit;
  let exited = null;
  process.exit = (c) => { exited = c; };
  try {
    broker._onChildExit(jobs[1], 0); // B exits
  } finally {
    process.exit = realExit;
  }
  const queuedTokens = broker._state.pendingQuestions.map(e => e.token);
  assert.ok(!queuedTokens.includes('2-caf'), 'B must be removed from queue after exit');
  assert.ok(/dropping question/i.test(stderr.text()), 'warning about dropped question must be logged to stderr');
});

// ── (d) Sound suppression: only first queued item chimes ─────────────────────

test('Sound: chime fires only on first enqueue, not subsequent', () => {
  const jobs = [{ token: '1-c', id: '1', cmd: 'coding' }, { token: '2-caf', id: '2', cmd: 'code-assess-fix' }];
  const { broker, chimeCalls } = makeBroker(jobs);
  const childA = makeFakeChild();
  const childB = makeFakeChild();
  broker._enqueue({ token: '1-c', topic: 'alpha', role: 'planning', questionsText: 'Q-A', child: childA, job: jobs[0] });
  const after1 = chimeCalls.count;
  broker._enqueue({ token: '2-caf', topic: 'beta', role: 'planning', questionsText: 'Q-B', child: childB, job: jobs[1] });
  const after2 = chimeCalls.count;
  assert.strictEqual(after1, 1, 'first enqueue must chime exactly once');
  assert.strictEqual(after2, 1, 'second enqueue while active must NOT chime again (spam guard)');
});

// ── (e) `[<token>] (<topic>)` prefix formatting ──────────────────────────────

test('Prefix banner uses `[<token>] (<topic>)` format', () => {
  const jobs = [{ token: '2-caf', id: '2', cmd: 'code-assess-fix' }];
  const { broker, stdout } = makeBroker(jobs);
  const childA = makeFakeChild();
  broker._enqueue({ token: '2-caf', topic: 'claude_harness', role: 'planning', questionsText: '1. test?', child: childA, job: jobs[0] });
  const out = stdout.text();
  assert.ok(/\[2-caf\] \(claude_harness\)/.test(out),
    `expected banner '[2-caf] (claude_harness)' in stdout. Got: ${out}`);
});

// ── (f) FIFO strict ordering across 3 enqueues ───────────────────────────────

test('FIFO strict: A, B, C enqueued → answers processed A, B, C', () => {
  const jobs = [
    { token: '1-c', id: '1', cmd: 'coding' },
    { token: '2-caf', id: '2', cmd: 'code-assess-fix' },
    { token: '3-p', id: '3', cmd: 'planning' },
  ];
  const { broker } = makeBroker(jobs);
  const cA = makeFakeChild();
  const cB = makeFakeChild();
  const cC = makeFakeChild();
  broker._enqueue({ token: '1-c', topic: 'a', role: 'planning', questionsText: 'qa', child: cA, job: jobs[0] });
  broker._enqueue({ token: '2-caf', topic: 'b', role: 'planning', questionsText: 'qb', child: cB, job: jobs[1] });
  broker._enqueue({ token: '3-p', topic: 'c', role: 'planning', questionsText: 'qc', child: cC, job: jobs[2] });
  assert.strictEqual(broker._state.active.token, '1-c');
  broker._submitActive('ans-a');
  assert.strictEqual(broker._state.active.token, '2-caf');
  broker._submitActive('ans-b');
  assert.strictEqual(broker._state.active.token, '3-p');
  broker._submitActive('ans-c');
  assert.strictEqual(cA.sent[0].text, 'ans-a');
  assert.strictEqual(cB.sent[0].text, 'ans-b');
  assert.strictEqual(cC.sent[0].text, 'ans-c');
});

// ── (g) Queued-notice line uses `{topic}: [B] queued: N pending questions` ───

test('Queued notice uses `{topic}: [B] queued: N pending questions`', () => {
  const jobs = [{ token: '1-c', id: '1', cmd: 'coding' }, { token: '2-caf', id: '2', cmd: 'code-assess-fix' }];
  const { broker, stdout } = makeBroker(jobs);
  broker._enqueue({ token: '1-c', topic: 'alpha', role: 'planning', questionsText: 'q', child: makeFakeChild(), job: jobs[0] });
  broker._enqueue({ token: '2-caf', topic: 'beta', role: 'planning', questionsText: 'q', child: makeFakeChild(), job: jobs[1] });
  assert.ok(/beta:\s*\[B\]\s*queued:\s*1\s*pending questions/.test(stdout.text()),
    `expected "{topic}: [B] queued: N pending questions" notice. Got: ${stdout.text()}`);
});

// ── Serial branch (capabilities.subAgents=false) ─────────────────────────────

function mockRegistryForStart(subAgents) {
  const registryPath = require.resolve(path.join(HARNESS, 'src', 'lib', 'providers', 'registry'));
  const originalEntry = require.cache[registryPath];
  require.cache[registryPath] = {
    id: registryPath, filename: registryPath, loaded: true,
    exports: { getProvider: () => ({ id: 'github-copilot', capabilities: { subAgents } }) },
    children: [], paths: [],
  };
  return () => {
    if (originalEntry) require.cache[registryPath] = originalEntry;
    else delete require.cache[registryPath];
  };
}

test('(PB-S1) serial: start() emits WARN and does not emit parallel launch log', () => {
  const jobs = [
    { token: 'X', id: null, cmd: 'coding' },
    { token: 'Y', id: null, cmd: 'coding' },
  ];
  const stdout = makeOutSink();
  const stderr = makeOutSink();
  const restore = mockRegistryForStart(false);
  const broker = createBroker({
    runAgentPath: path.join(HARNESS, 'src', 'run-agent.js'),
    jobs,
    env: process.env,
    stdout,
    stderr,
    stdin: { isTTY: false, resume: () => {}, on: () => {}, removeListener: () => {} },
    chime: () => {},
  });
  const origExit = process.exit;
  process.exit = () => {};
  try { broker.start(); } finally { process.exit = origExit; restore(); }

  const out = stdout.text();
  assert.ok(
    /subAgents.*false|serial|sequential/i.test(out),
    `Expected WARN about serial execution. Got: ${out}`
  );
  assert.ok(
    !/Launching.*job.*broker/i.test(out),
    `Serial branch must not emit "Launching N job(s) via broker". Got: ${out}`
  );
});

test('(PB-S2) parallel: start() emits launch log when subAgents=true', () => {
  const jobs = [
    { token: 'P', id: null, cmd: 'coding' },
    { token: 'Q', id: null, cmd: 'coding' },
  ];
  const stdout = makeOutSink();
  const stderr = makeOutSink();
  const restore = mockRegistryForStart(true);
  const broker = createBroker({
    runAgentPath: path.join(HARNESS, 'src', 'run-agent.js'),
    jobs,
    env: process.env,
    stdout,
    stderr,
    stdin: { isTTY: false, resume: () => {}, on: () => {}, removeListener: () => {} },
    chime: () => {},
  });
  const origExit = process.exit;
  process.exit = () => {};
  try { broker.start(); } finally { process.exit = origExit; restore(); }

  const out = stdout.text();
  assert.ok(
    /Launching.*job.*broker/i.test(out),
    `Parallel branch must emit "Launching N job(s) via broker". Got: ${out}`
  );
});

test('(PB-S3) serial: exit log ordering matches job declaration order', () => {
  const jobs = [
    { token: 'first',  id: null, cmd: 'coding' },
    { token: 'second', id: null, cmd: 'coding' },
  ];
  const stdout = makeOutSink();
  const restore = mockRegistryForStart(false);
  const broker = createBroker({
    runAgentPath: path.join(HARNESS, 'src', 'run-agent.js'),
    jobs,
    env: process.env,
    stdout,
    stderr: { write: () => {} },
    stdin: { isTTY: false, resume: () => {}, on: () => {}, removeListener: () => {} },
    chime: () => {},
  });
  restore();

  const origExit = process.exit;
  process.exit = () => {};
  try {
    broker._onChildExit(jobs[0], 0);
    broker._onChildExit(jobs[1], 0);
  } finally { process.exit = origExit; }

  const lines = stdout.buf;
  const idxFirst  = lines.findIndex(l => l.includes('first')  && /exit/i.test(l));
  const idxSecond = lines.findIndex(l => l.includes('second') && /exit/i.test(l));
  assert.ok(idxFirst  >= 0, 'Expected exit log for token "first"');
  assert.ok(idxSecond >= 0, 'Expected exit log for token "second"');
  assert.ok(idxFirst < idxSecond, 'first exit log must appear before second exit log');
});

test('(PB-S4) source: spawnNextSequential and capabilities.subAgents present in broker source', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'parallel-broker.js'), 'utf8');
  assert.ok(/spawnNextSequential/.test(src),   'parallel-broker.js must define spawnNextSequential');
  assert.ok(/capabilities\.subAgents/.test(src), 'parallel-broker.js must branch on capabilities.subAgents');
});

// ── Staging + FIFO splice gate + crash recovery ──────────────────────────────

const fs = require('fs');
const os = require('os');
const parallelBatch = require(path.join(HARNESS, 'src', 'lib', 'parallel-batch.js'));

test('(STAGING-a) crash-mid-batch: later prompt stays in staging when earlier crashes (FIFO gate blocks)', () => {
  const topicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-test-a-'));
  const historyPath = path.join(topicDir, 'history.md');
  fs.writeFileSync(historyPath, '# History\n\n');
  try {
    parallelBatch.writeStagingPrompt(topicDir, 0, 'task-alpha', 'Alpha prompt body');
    parallelBatch.writeStagingPrompt(topicDir, 1, 'task-beta', 'Beta prompt body');
    // seq 1 completes; seq 0 crashes — no .done for seq 0
    parallelBatch.markStagingComplete(topicDir, 1, 'task-beta', '## Response\n\nbeta done');
    const spliceState = { next: 0 };
    parallelBatch.spliceStagingSync(historyPath, topicDir, spliceState);
    const hist = fs.readFileSync(historyPath, 'utf8');
    assert.ok(!hist.includes('Alpha prompt body'), 'seq 0 not done — must not appear in history');
    assert.ok(!hist.includes('Beta prompt body'), 'seq 1 blocked by seq 0 FIFO gate — must not appear in history');
    assert.strictEqual(spliceState.next, 0, 'splice cursor must remain at 0 (blocked)');
    const stageDir = path.join(topicDir, '.staging');
    assert.ok(fs.existsSync(path.join(stageDir, '0000-task-alpha.md')), 'seq 0 staging file must remain on disk');
    assert.ok(fs.existsSync(path.join(stageDir, '0001-task-beta.md')), 'seq 1 staging file must remain on disk (not yet eligible)');
  } finally {
    try { fs.rmSync(topicDir, { recursive: true, force: true }); } catch {}
  }
});

test('(STAGING-b) FIFO order: prompt 1 finishes before prompt 0 — both spliced in queue order', () => {
  const topicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-test-b-'));
  const historyPath = path.join(topicDir, 'history.md');
  fs.writeFileSync(historyPath, '');
  try {
    parallelBatch.writeStagingPrompt(topicDir, 0, 'first', 'First prompt body');
    parallelBatch.writeStagingPrompt(topicDir, 1, 'second', 'Second prompt body');
    const spliceState = { next: 0 };
    // seq 1 finishes first
    parallelBatch.markStagingComplete(topicDir, 1, 'second', '## R2\n\nresult-two');
    parallelBatch.spliceStagingSync(historyPath, topicDir, spliceState);
    assert.ok(!fs.readFileSync(historyPath, 'utf8').includes('Second prompt body'),
      'seq 1 must not be spliced before seq 0 (FIFO gate)');
    // seq 0 finishes
    parallelBatch.markStagingComplete(topicDir, 0, 'first', '## R1\n\nresult-one');
    parallelBatch.spliceStagingSync(historyPath, topicDir, spliceState);
    const hist = fs.readFileSync(historyPath, 'utf8');
    const pos0 = hist.indexOf('First prompt body');
    const pos1 = hist.indexOf('Second prompt body');
    assert.ok(pos0 >= 0, 'first prompt must appear in history');
    assert.ok(pos1 >= 0, 'second prompt must appear in history');
    assert.ok(pos0 < pos1, 'first prompt must precede second (FIFO order preserved)');
    assert.strictEqual(spliceState.next, 2, 'splice cursor must advance past both entries');
  } finally {
    try { fs.rmSync(topicDir, { recursive: true, force: true }); } catch {}
  }
});

test('(STAGING-c) recovery: completed staging spliced into history; incomplete re-prepended to queue', () => {
  const topicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-test-c-'));
  const historyPath = path.join(topicDir, 'history.md');
  const queuePath = path.join(topicDir, 'prompt-queue.md');
  fs.writeFileSync(historyPath, '# History\n\n');
  fs.writeFileSync(queuePath, '');
  try {
    // seq 0: runner completed — has .done
    parallelBatch.writeStagingPrompt(topicDir, 0, 'done-task', 'Completed prompt body');
    parallelBatch.markStagingComplete(topicDir, 0, 'done-task', '## Agent Response\n\ncompleted result');
    // seq 1: runner crashed — no .done
    parallelBatch.writeStagingPrompt(topicDir, 1, 'crashed-task', 'Crashed prompt body');
    const result = parallelBatch.recoverStagingOrphans(topicDir, historyPath, queuePath);
    assert.strictEqual(result.spliced, 1, 'one completed entry must be spliced');
    assert.strictEqual(result.requeued, 1, 'one incomplete entry must be re-queued');
    const hist = fs.readFileSync(historyPath, 'utf8');
    assert.ok(hist.includes('Completed prompt body'), 'completed prompt must appear in history');
    assert.ok(hist.includes('completed result'), 'agent output must appear in history');
    const queue = fs.readFileSync(queuePath, 'utf8');
    assert.ok(queue.includes('Crashed prompt body'), 'incomplete prompt must be re-prepended to queue');
    const stageDir = path.join(topicDir, '.staging');
    const remaining = fs.existsSync(stageDir)
      ? fs.readdirSync(stageDir).filter(f => f.endsWith('.md'))
      : [];
    assert.strictEqual(remaining.length, 0, 'all staging .md files must be cleaned up after recovery');
  } finally {
    try { fs.rmSync(topicDir, { recursive: true, force: true }); } catch {}
  }
});

if (!process.exitCode) console.log('\nAll regression tests passed.');
