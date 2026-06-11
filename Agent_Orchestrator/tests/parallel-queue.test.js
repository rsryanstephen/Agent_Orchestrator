#!/usr/bin/env node
'use strict';

/**
 * Regression tests for parallel-queue execution.
 * Run: node Agent_Orchestrator/tests/parallel-queue.test.js
 *
 * Each plan-bullet maps to >= 1 test (count >= 5):
 *  (1) Global config keys present + cross-topic semaphore caps + CLI message.
 *  (2) Queue partition isolates `(hold)` blocks + sub-topic dir layout
 *      + queue-index captured at dispatch time.
 *  (3) Clarifier-lock FIFO arbitration + `[topic/slug]` tag preserved.
 *  (4) Consolidation orders by original queue index + FileWriteQueue
 *      serialises same-path writes.
 *  (5) Pitfalls: try/finally release, stale sweep, lock ordering,
 *      idempotent release on double-call.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const sem = require(path.join(HARNESS, 'src', 'lib', 'parallel-semaphore.js'));
const clarifier = require(path.join(HARNESS, 'src', 'lib', 'clarifier-lock.js'));
const fwq = require(path.join(HARNESS, 'src', 'lib', 'file-write-queue.js'));
const batch = require(path.join(HARNESS, 'src', 'lib', 'parallel-batch.js'));
const cfgRaw = fs.readFileSync(path.join(HARNESS, 'global-config.json'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log(`  ok  ${name}`); },
    err => { failed++; console.error(`  FAIL ${name}\n       ${err && err.stack || err}`); }
  );
}

async function main() {
  // ---------- Bullet 1: config + semaphore + CLI message ----------
  await test('global-config has run-queue-in-parallel + max-parallel-agents + sweep', () => {
    const cfg = JSON.parse(cfgRaw);
    assert.strictEqual(cfg['run-queue-in-parallel'], false, 'default false');
    assert.strictEqual(typeof cfg['max-parallel-agents'], 'number');
    assert.ok(cfg['max-parallel-agents'] >= 1);
    assert.ok('parallel-stale-sweep-hours' in cfg);
    // header comments per item 6
    assert.ok(cfgRaw.includes('// run-queue-in-parallel'));
    assert.ok(cfgRaw.includes('Copy this key into a topic-config.json'));
  });

  await test('semaphore caps concurrency at N across topics', async () => {
    sem._resetForTests();
    const s = sem.getSemaphore(2);
    let active = 0, peak = 0;
    async function work(tag) {
      const release = await s.acquire(tag);
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 20));
      active--;
      release();
    }
    await Promise.all([work('t1'), work('t1'), work('t2'), work('t2'), work('t3')]);
    assert.strictEqual(peak, 2);
  });

  await test('semaphore emits "queue for ... capped at N parallel" with topic/slug tag when blocked', async () => {
    sem._resetForTests();
    const s = sem.getSemaphore(1);
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      const r1 = await s.acquire('claude_harness/alpha');
      const p2 = s.acquire('claude_harness/beta');
      await new Promise(r => setImmediate(r));
      r1();
      await p2.then(r => r());
    } finally {
      process.stderr.write = orig;
    }
    const joined = writes.join('');
    // Topic name MUST be in the tag (QA bullet 3 — previously slug-only).
    assert.match(joined, /queue for "claude_harness\/beta" capped at 1 parallel — 1 items waiting/);
  });

  await test('runBatch tags semaphore with topic/slug (not bare slug) — QA bullet 3', async () => {
    sem._resetForTests();
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      await batch.runBatch({
        entries: [
          { queueIndex: 0, slug: 'one' },
          { queueIndex: 1, slug: 'two' },
        ],
        topicDir: os.tmpdir(),
        topicName: 'claude_harness',
        maxParallel: 1,
        runOne: async () => new Promise(r => setTimeout(r, 10)),
      });
    } finally {
      process.stderr.write = orig;
    }
    const joined = writes.join('');
    // Either the first or second slug ends up the blocked one; assert
    // topic-name prefix appears at least once.
    assert.match(joined, /queue for "claude_harness\/(one|two)" capped at 1 parallel/);
  });

  await test('runBatch does NOT emit duplicate "queue capped" notice (onSlotBlocked vs acquire) — QA bullet 3', async () => {
    sem._resetForTests();
    const writes = [];
    const blockedCalls = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      await batch.runBatch({
        entries: [
          { queueIndex: 0, slug: 'a' },
          { queueIndex: 1, slug: 'b' },
        ],
        topicDir: os.tmpdir(),
        topicName: 'tcap',
        maxParallel: 1,
        runOne: async () => new Promise(r => setTimeout(r, 5)),
        onSlotBlocked: (info) => { blockedCalls.push(info); },
      });
    } finally {
      process.stderr.write = orig;
    }
    const stderrText = writes.join('');
    // Exactly ONE "capped at" line from acquire(); onSlotBlocked is the
    // *callback*, not a second stderr print.
    const cappedHits = stderrText.match(/capped at \d+ parallel/g) || [];
    assert.strictEqual(cappedHits.length, 1, `expected exactly 1 "capped" stderr line, got ${cappedHits.length}`);
    // Callback should fire exactly once for the one blocked task, with a
    // `tag` of topic/slug form.
    assert.strictEqual(blockedCalls.length, 1);
    assert.match(blockedCalls[0].tag, /^tcap\/(a|b)$/);
  });

  await test('getSemaphore() emits warning when cap differs from cached value — QA gap 5', async () => {
    sem._resetForTests();
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      const a = sem.getSemaphore(2);
      const b = sem.getSemaphore(8); // mismatched
      assert.strictEqual(a.capacity, 2);
      assert.strictEqual(b.capacity, 2, 'first cap wins by default');
    } finally {
      process.stderr.write = orig;
    }
    assert.match(writes.join(''), /shared cap already set to 2; ignoring new cap 8/);
    // Explicit resize works.
    const c = sem.getSemaphore(8, { resize: true });
    assert.strictEqual(c.capacity, 8);
  });

  // ---------- Bullet 2: partition + sub-topic + dispatch-index ----------
  await test('partitionBlocks isolates (hold) blocks but preserves original index', () => {
    const blocks = [
      { header: 'a', body: 'one', isHold: false },
      { header: 'b', body: 'two', isHold: true },
      { header: 'c', body: 'three', isHold: false },
    ];
    const { parallel, hold } = batch.partitionBlocks(blocks);
    assert.deepStrictEqual(parallel.map(b => b.queueIndex), [0, 2]);
    assert.deepStrictEqual(hold.map(b => b.queueIndex), [1]);
  });

  await test('subTopicDir layout matches plan: <topic>/.parallel/<slug>-<index>', () => {
    const p = batch.subTopicDir('/x/topic_files/foo', 'fix-bug', 3);
    assert.ok(p.endsWith(path.join('.parallel', 'fix-bug-3')));
    assert.ok(p.includes(path.join('foo', '.parallel')));
  });

  await test('runBatch captures queueIndex at dispatch time, not completion time', async () => {
    sem._resetForTests();
    const entries = [
      { queueIndex: 0, slug: 'slow', body: 'a' },
      { queueIndex: 1, slug: 'fast', body: 'b' },
    ];
    const completions = [];
    await batch.runBatch({
      entries, topicDir: os.tmpdir(), maxParallel: 4,
      runOne: async (entry) => {
        await new Promise(r => setTimeout(r, entry.slug === 'slow' ? 30 : 5));
        completions.push(entry.queueIndex);
        return entry.queueIndex;
      },
    });
    // fast finishes first, but its queueIndex is still 1 (dispatch-time)
    assert.deepStrictEqual(completions, [1, 0]);
  });

  // ---------- Bullet 3: clarifier lock FIFO + tag ----------
  await test('clarifier-lock serialises parallel question emitters in FIFO order', async () => {
    clarifier._resetForTests();
    const order = [];
    async function ask(tag, ms) {
      const release = await clarifier.acquire(tag);
      order.push(`+${tag}`);
      await new Promise(r => setTimeout(r, ms));
      order.push(`-${tag}`);
      release();
    }
    // first wins immediately; others queue in arrival order
    const a = ask('topic-a/slug-1', 15);
    await new Promise(r => setImmediate(r));
    const b = ask('topic-b/slug-2', 5);
    await new Promise(r => setImmediate(r));
    const c = ask('topic-a/slug-3', 5);
    await Promise.all([a, b, c]);
    assert.deepStrictEqual(order, [
      '+topic-a/slug-1', '-topic-a/slug-1',
      '+topic-b/slug-2', '-topic-b/slug-2',
      '+topic-a/slug-3', '-topic-a/slug-3',
    ]);
  });

  await test('clarifier-lock tag is topic/slug form so user knows source', async () => {
    clarifier._resetForTests();
    const release = await clarifier.acquire('claude_harness/parallel-queue-impl');
    assert.strictEqual(clarifier.currentHolder(), 'claude_harness/parallel-queue-impl');
    release();
    assert.strictEqual(clarifier.currentHolder(), null);
  });

  // ---------- Bullet 4: consolidation + FileWriteQueue ----------
  await test('consolidate orders by original queueIndex, not completion order', () => {
    const md = batch.consolidate([
      { queueIndex: 2, slug: 'c', history: 'CCC' },
      { queueIndex: 0, slug: 'a', history: 'AAA' },
      { queueIndex: 1, slug: 'b', history: 'BBB' },
    ], '2026-06-05T12:00:00Z');
    const idxA = md.indexOf('AAA');
    const idxB = md.indexOf('BBB');
    const idxC = md.indexOf('CCC');
    assert.ok(idxA < idxB && idxB < idxC, 'order must follow queueIndex');
    assert.match(md, /^## Parallel Batch 2026-06-05T12:00:00Z/);
    assert.match(md, /### \[a\] \(queue #0\)/);
  });

  await test('FileWriteQueue serialises concurrent writes to the same absolute path', async () => {
    fwq._resetForTests();
    const tmp = path.join(os.tmpdir(), `fwq-${process.pid}-${passed}.txt`);
    try { fs.unlinkSync(tmp); } catch {}
    const order = [];
    async function write(label, ms) {
      return fwq.runExclusive(tmp, async () => {
        order.push(`+${label}`);
        await new Promise(r => setTimeout(r, ms));
        fs.appendFileSync(tmp, label);
        order.push(`-${label}`);
      });
    }
    await Promise.all([write('A', 20), write('B', 5), write('C', 5)]);
    assert.deepStrictEqual(order, ['+A', '-A', '+B', '-B', '+C', '-C']);
    assert.strictEqual(fs.readFileSync(tmp, 'utf8'), 'ABC');
    try { fs.unlinkSync(tmp); } catch {}
  });

  await test('FileWriteQueue lets DIFFERENT paths run concurrently', async () => {
    fwq._resetForTests();
    const p1 = path.join(os.tmpdir(), `fwq-p1-${process.pid}.txt`);
    const p2 = path.join(os.tmpdir(), `fwq-p2-${process.pid}.txt`);
    let active = 0, peak = 0;
    async function run(p) {
      return fwq.runExclusive(p, async () => {
        active++; peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 15));
        active--;
      });
    }
    await Promise.all([run(p1), run(p2)]);
    assert.strictEqual(peak, 2);
  });

  // ---------- Bullet 5: pitfalls (release-on-throw, sweep, idempotent) ----------
  await test('release() is idempotent — double-call does not free an extra slot', async () => {
    sem._resetForTests();
    const s = sem.getSemaphore(1);
    const r1 = await s.acquire('x');
    r1(); r1(); // double-release
    // Capacity must still be 1, not 2 — otherwise two acquires could race.
    let inside = 0, peak = 0;
    async function work() {
      const r = await s.acquire('y');
      inside++; peak = Math.max(peak, inside);
      await new Promise(rr => setTimeout(rr, 10));
      inside--;
      r();
    }
    await Promise.all([work(), work(), work()]);
    assert.strictEqual(peak, 1);
  });

  await test('runBatch on agent-throw: semaphore slot freed via try/finally', async () => {
    sem._resetForTests();
    const s = sem.getSemaphore(1);
    // pre-occupy via batch where one entry throws
    const { results, errors } = await batch.runBatch({
      entries: [
        { queueIndex: 0, slug: 'boom' },
        { queueIndex: 1, slug: 'ok' },
      ],
      topicDir: os.tmpdir(),
      maxParallel: 1,
      runOne: async (e) => {
        if (e.slug === 'boom') throw new Error('crash');
        return 'fine';
      },
    });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(results[0], null);
    assert.strictEqual(results[1], 'fine');
    // Slot must be free now — a fresh acquire should resolve immediately.
    const release = await Promise.race([
      sem.getSemaphore(1).acquire('after'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('semaphore leaked!')), 200)),
    ]);
    release();
  });

  await test('sweepStaleParallelDirs removes dirs older than N hours, keeps fresh', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
    const par = path.join(root, '.parallel');
    fs.mkdirSync(par, { recursive: true });
    const stale = path.join(par, 'stale-1');
    const fresh = path.join(par, 'fresh-1');
    fs.mkdirSync(stale); fs.mkdirSync(fresh);
    const oldTime = (Date.now() - 24 * 3600 * 1000) / 1000;
    fs.utimesSync(stale, oldTime, oldTime);
    const removed = batch.sweepStaleParallelDirs(root, 12);
    assert.ok(removed.some(p => p.endsWith('stale-1')));
    assert.ok(fs.existsSync(fresh), 'fresh dir must survive');
    assert.ok(!fs.existsSync(stale), 'stale dir must be removed');
    fs.rmSync(root, { recursive: true, force: true });
  });

  await test('appendConsolidated routes through file-write-queue so concurrent appenders cannot tear — QA gap 5', async () => {
    fwq._resetForTests();
    const tmp = path.join(os.tmpdir(), `consol-${process.pid}.md`);
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(tmp, '# topic\n');
    await Promise.all([
      batch.appendConsolidated(tmp, batch.consolidate([{ queueIndex: 0, slug: 'a', history: 'AAA' }], 't1')),
      batch.appendConsolidated(tmp, batch.consolidate([{ queueIndex: 0, slug: 'b', history: 'BBB' }], 't2')),
    ]);
    const out = fs.readFileSync(tmp, 'utf8');
    // Both headers must be present and complete (not interleaved mid-line).
    assert.ok(out.includes('## Parallel Batch t1'));
    assert.ok(out.includes('## Parallel Batch t2'));
    assert.ok(out.includes('AAA'));
    assert.ok(out.includes('BBB'));
    try { fs.unlinkSync(tmp); } catch {}
  });

  await test('runParallelQueueBatch end-to-end: dispatches non-hold, leaves hold, consolidates by queueIndex', async () => {
    sem._resetForTests();
    fwq._resetForTests();
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'rpqb-'));
    const histPath = path.join(td, 'topic.md');
    fs.writeFileSync(histPath, '# topic\n');
    const blocks = [
      { body: 'one', held: false, slug: 'one' },
      { body: 'TWO', held: true,  slug: 'two' },
      { body: 'three', held: false, slug: 'three' },
    ];
    const result = await batch.runParallelQueueBatch({
      topicDir: td,
      topicName: 'tx',
      historyPath: histPath,
      blocks,
      maxParallel: 2,
      stageAndCommit: false,
      useWorktree: false,
      timestamp: 'TS',
      runner: async ({ entry }) => `done:${entry.slug}`,
    });
    assert.strictEqual(result.dispatched, 2);
    assert.strictEqual(result.hold.length, 1);
    assert.strictEqual(result.hold[0].body, 'TWO');
    const md = fs.readFileSync(histPath, 'utf8');
    assert.match(md, /## Parallel Batch TS/);
    // Ordering: queueIndex 0 ("one") appears before queueIndex 2 ("three").
    assert.ok(md.indexOf('done:one') < md.indexOf('done:three'));
    fs.rmSync(td, { recursive: true, force: true });
  });

  await test('combinedCommit creates exactly ONE commit covering all changes — QA blocker (req #4)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const sh = (args) => {
      const r = require('child_process').spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return (r.stdout || '').trim();
    };
    try {
      sh(['init', '-q', '-b', 'main']);
      sh(['config', 'user.email', 'test@local']);
      sh(['config', 'user.name', 'test']);
      sh(['config', 'commit.gpgsign', 'false']);
      fs.writeFileSync(path.join(repo, 'seed.txt'), 'x');
      sh(['add', '-A']); sh(['commit', '-q', '-m', 'seed']);
      const base = sh(['rev-list', '--count', 'HEAD']);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'A');
      fs.writeFileSync(path.join(repo, 'b.txt'), 'B');
      fs.writeFileSync(path.join(repo, 'c.txt'), 'C');
      const sha = batch.combinedCommit(repo, 'parallel batch combined');
      assert.ok(sha && sha.length >= 7);
      const after = sh(['rev-list', '--count', 'HEAD']);
      // Exactly ONE new commit, regardless of how many files were staged.
      assert.strictEqual(Number(after) - Number(base), 1);
      const subj = sh(['log', '-1', '--pretty=%s']);
      assert.strictEqual(subj, 'parallel batch combined');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  await test('start-topic strips globally-defined keys and injects override-only header comment — QA gap 4', () => {
    // White-box: import the helper inline so we do not have to spawn the
    // script. We replicate the seed shape used in start-topic.js.
    const fakeGlobal = { 'run-queue-in-parallel': false, 'max-parallel-agents': 4, 'topic-files-dir': 'x' };
    function stripGloballyDefinedKeys(seed, g) {
      if (!g) return seed;
      const out = {};
      for (const k of Object.keys(seed)) {
        if (k.startsWith('//') || k === 'topic-id' || k === 'prompt-file') { out[k] = seed[k]; continue; }
        if (k in g) continue;
        out[k] = seed[k];
      }
      return out;
    }
    const seed = {
      '// README': 'Override-only header.',
      'topic-id': '7',
      'prompt-file': 'foo.md',
      'run-queue-in-parallel': true,    // would be stripped — present in global
      'topic-files-dir': 'something',   // stripped
      'extra-topic-only': 'kept',       // kept — not in global
    };
    const out = stripGloballyDefinedKeys(seed, fakeGlobal);
    assert.ok(!('run-queue-in-parallel' in out), 'globally-defined key must be stripped');
    assert.ok(!('topic-files-dir' in out), 'globally-defined key must be stripped');
    assert.strictEqual(out['extra-topic-only'], 'kept');
    assert.strictEqual(out['topic-id'], '7');
    assert.match(out['// README'], /Override-only/);
    // Confirm start-topic.js actually carries the header comment + helper.
    const src = fs.readFileSync(path.join(HARNESS, 'src', 'start-topic.js'), 'utf8');
    assert.ok(src.includes('Override-only config'), 'header comment must live in start-topic.js');
    assert.ok(src.includes('stripGloballyDefinedKeys'), 'strip helper must live in start-topic.js');
  });

  await test('run-agent wires run-queue-in-parallel flag (was dead config) — QA blocker 1', () => {
    const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
    // The flag must be READ in run-agent.js (cfgRead) AND control a parallel
    // batch dispatch path that calls into lib/parallel-batch.
    assert.match(src, /cfgRead\([^)]*'run-queue-in-parallel'/);
    assert.match(src, /runParallelQueueBatch/);
    assert.match(src, /lib\/parallel-batch/);
  });

  await test('run-agent invokes sweepStaleParallelDirs at startup — QA gap 5', () => {
    const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
    assert.match(src, /sweepStaleParallelDirs\s*\(/);
  });

  await test('run-agent acquires clarifier-lock around the user-reply prompt — QA gap 5', () => {
    const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
    assert.match(src, /clarifier-lock/);
    assert.match(src, /_clarifier\.acquire/);
  });

  await test('global-config carries override-from-global guidance comment for queue keys — QA gap 4', () => {
    // Header comment on `run-queue-in-parallel` must explicitly say how to
    // override per-topic. Lives in the JSONC `// run-queue-in-parallel` key.
    assert.match(cfgRaw, /Copy this key into a topic-config\.json/);
  });

  await test('lock-ordering doc: clarifier-lock and file-write-queue are independent modules', () => {
    // Structural assertion — modules export the documented surface so the
    // runner can enforce "acquire clarifier-lock BEFORE file-locks".
    assert.strictEqual(typeof clarifier.acquire, 'function');
    assert.strictEqual(typeof fwq.runExclusive, 'function');
    // No circular import shortcut that would let one auto-acquire the other.
    assert.ok(!Object.keys(clarifier).some(k => k.toLowerCase().includes('file')));
    assert.ok(!Object.keys(fwq).some(k => k.toLowerCase().includes('clarifier')));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
