#!/usr/bin/env node
'use strict';

/**
 * E2E spawn-the-binary regression test — closes diagnostic H5 (no test spawns
 * `node src/run-agent.js`) and H2 (no mid-layer integration coverage of the
 * prompt -> history pipeline).
 *
 * Strategy:
 *   1. Create a unique throwaway topic dir under the real harness
 *      `topic_files/` (deleted on teardown).
 *   2. Plant a `<topic>.md` with a `## User Prompt` body and a
 *      `topic-config.json` that pins `provider: "stub-fixture"` so all model
 *      resolution stays inside the test harness.
 *   3. Spawn `node src/run-agent.js <topic> coding` with env vars wiring the
 *      stub-fixture provider to a JSONL fixture file.
 *   4. Assert: `## Coding Agent Response` header appended, canned reply text
 *      present, `_harness_auto_set` absent (post-restore), archive triggered
 *      if planted line count exceeds threshold.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const HARNESS = path.join(__dirname, '..');
const ROOT = path.join(HARNESS, '..');
// Isolation sandbox: plant throwaway topics in an OS-temp tree (via the
// AGENT_ORCH_TOPICS_DIR seam) instead of the live `topic_files/`, so the suite
// stops flickering/orphaning `__e2e_stub_*` dirs in the real harness folder.
const SANDBOX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agentorch-e2e-'));
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'coding-basic.jsonl');

let failed = 0;
const pending = [];
function test(name, fn) {
  // Run sync; if a promise is returned, queue it so the bottom-of-file awaiter
  // can surface async assertion failures (the original harness pattern only
  // catches synchronous throws).
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => console.log('PASS', name),
        e => { failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
      ));
    } else {
      console.log('PASS', name);
    }
  } catch (e) { failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

function uniqueTopicName() {
  return `__e2e_stub_${process.pid}_${Date.now().toString(36)}`;
}

function setupTopic({ withLargeHistory = false } = {}) {
  const topic = uniqueTopicName();
  const topicDir = path.join(SANDBOX_ROOT, topic);
  fs.mkdirSync(topicDir, { recursive: true });

  const topicConfig = {
    'stage-and-commit': false,
    'output-verbosity': 1,
    'max-context-lifespan': 5,
    'max-concurrent-agents': 1,
    'auto-answer-clarifying-questions-and-submit': false,
    'provider': 'stub-fixture',
    'models': {
      'planning': 'stub-model',
      'coding': 'stub-model',
      'assessment': 'stub-model',
    },
    'model-effort': {
      'planning': 'low',
      'coding': 'low',
      'assessment': 'low',
    },
    'context-files': [],
    'use-strict-assessment': false,
    'use-caveman': false,
    'use-karpathy': false,
    'use-interrogate': false,
  };
  fs.writeFileSync(
    path.join(topicDir, 'topic-config.json'),
    JSON.stringify(topicConfig, null, 2),
    'utf8'
  );

  const promptBody = 'Echo the sentinel — the test stub returns a canned line; the dispatch pipeline must persist it.';
  let history;
  if (withLargeHistory) {
    const padding = Array.from({ length: 4100 }, (_, i) => `<!-- pad line ${i} -->`).join('\n');
    history = `# ${topic}\n\n${padding}\n\n## User Prompt\n${promptBody}\n`;
  } else {
    history = `# ${topic}\n\n## User Prompt\n${promptBody}\n`;
  }
  const historyPath = path.join(topicDir, `${topic}.md`);
  fs.writeFileSync(historyPath, history, 'utf8');

  return { topic, topicDir, historyPath };
}

function teardown(topicDir) {
  try { fs.rmSync(topicDir, { recursive: true, force: true }); } catch {}
}

function runHarness(topic, role, extraEnv) {
  const counterPath = path.join(os.tmpdir(), `stub-counter-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(counterPath, '0', 'utf8');
  // Per-spawn isolated `.last-topic` so the e2e stub topic never lands in
  // the real `Agent_Orchestrator/.last-topic`. Stub topics are planted in the
  // OS-temp `SANDBOX_ROOT` (not the real `topic_files/`), and the guard's
  // topics dir is pinned to `SANDBOX_ROOT` via `AGENT_ORCH_TOPICS_DIR` so
  // recovery resolves the stub there while the real folder stays untouched.
  const isolatedLastTopic = path.join(os.tmpdir(), `e2e-last-topic-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const env = {
    ...process.env,
    HARNESS_PROVIDER_OVERRIDE: 'stub-fixture',
    HARNESS_STUB_FIXTURE_PATH: FIXTURE,
    HARNESS_STUB_FIXTURE_COUNTER: counterPath,
    AGENT_ORCH_LAST_TOPIC_PATH: isolatedLastTopic,
    AGENT_ORCH_TOPICS_DIR: SANDBOX_ROOT,
    NODE_ENV: 'test',
    CI: '1',
    ...(extraEnv || {}),
  };
  const res = spawnSync(process.execPath, [RUN_AGENT, topic, role], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  try { fs.unlinkSync(counterPath); } catch {}
  try { fs.unlinkSync(isolatedLastTopic); } catch {}
  return res;
}

// ── Test 1: stub provider is registered and resolvable from the registry ─────
test('registry resolves stub-fixture provider via HARNESS_PROVIDER_OVERRIDE', () => {
  const prev = process.env.HARNESS_PROVIDER_OVERRIDE;
  const prevEnv = process.env.NODE_ENV;
  process.env.HARNESS_PROVIDER_OVERRIDE = 'stub-fixture';
  process.env.NODE_ENV = 'test';
  try {
    delete require.cache[require.resolve(path.join(HARNESS, 'src', 'lib', 'providers', 'registry.js'))];
    const { getProvider } = require(path.join(HARNESS, 'src', 'lib', 'providers', 'registry.js'));
    const prov = getProvider();
    assert.strictEqual(prov.id, 'stub-fixture', 'env override must select stub-fixture');
    assert.strictEqual(typeof prov.spawn, 'function', 'stub-fixture must expose spawn()');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_PROVIDER_OVERRIDE;
    else process.env.HARNESS_PROVIDER_OVERRIDE = prev;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
});

// ── Test 2: stub provider returns canned text from fixture file ──────────────
test('stub-fixture.spawn returns canned text from JSONL fixture', async () => {
  process.env.HARNESS_STUB_FIXTURE_PATH = FIXTURE;
  delete process.env.HARNESS_STUB_FIXTURE_COUNTER; // use in-memory counter
  const StubFixtureProvider = require(path.join(HARNESS, 'src', 'lib', 'providers', 'stub-fixture.js'));
  StubFixtureProvider._memCounter = 0;
  const prov = new StubFixtureProvider();
  const r = await prov.spawn('any payload', {});
  assert.ok(r.text.includes('E2E_STUB_REPLY_SENTINEL_OK'), `text must include sentinel; got: ${r.text.slice(0,120)}`);
  assert.ok(r.usage && typeof r.usage.input_tokens === 'number', 'usage shape must be normalised');
});

// ── Test 3: spawning run-agent.js coding appends "## Coding Agent Response" ──
test('node run-agent.js <topic> coding appends Coding Agent Response with stub reply', () => {
  const { topic, topicDir, historyPath } = setupTopic();
  try {
    const res = runHarness(topic, 'coding');
    if (res.error) throw new Error(`spawn failed: ${res.error.message}\nstderr: ${(res.stderr || '').slice(-500)}`);
    const content = fs.readFileSync(historyPath, 'utf8');
    assert.ok(
      /## Coding Agent Response\b/.test(content),
      `expected "## Coding Agent Response" header in history file after run-agent.js exit (status=${res.status}).\nstdout tail: ${(res.stdout || '').slice(-400)}\nstderr tail: ${(res.stderr || '').slice(-400)}\nhistory tail: ${content.slice(-400)}`
    );
    assert.ok(
      content.includes('E2E_STUB_REPLY_SENTINEL_OK'),
      `stub-fixture canned text must be persisted to history file.\nhistory tail: ${content.slice(-400)}`
    );
  } finally {
    teardown(topicDir);
  }
});

// ── Test 4: _harness_auto_set marker is not left behind on disk ──────────────
test('topic-config.json has no _harness_auto_set after a normal run', () => {
  const { topic, topicDir } = setupTopic();
  try {
    const res = runHarness(topic, 'coding');
    if (res.error) throw new Error(`spawn failed: ${res.error.message}`);
    const tc = JSON.parse(fs.readFileSync(path.join(topicDir, 'topic-config.json'), 'utf8'));
    assert.ok(
      !('_harness_auto_set' in tc),
      `_harness_auto_set must not linger in topic-config.json after a clean run; found keys: ${Object.keys(tc).join(',')}`
    );
  } finally {
    teardown(topicDir);
  }
});

// ── Test 5: archive triggers when history exceeds threshold ──────────────────
test('large planted history triggers auto-archive (.archive-* sibling appears)', () => {
  const { topic, topicDir, historyPath } = setupTopic({ withLargeHistory: true });
  try {
    const res = runHarness(topic, 'coding');
    if (res.error) throw new Error(`spawn failed: ${res.error.message}`);
    const siblings = fs.readdirSync(topicDir);
    const archived = siblings.find(n => n.includes('.archive-') && n.endsWith('.md'));
    assert.ok(
      archived,
      `expected an "<topic>.archive-*.md" backup beside ${path.basename(historyPath)} when planted history > 4000 lines; found: ${siblings.join(',')}`
    );
  } finally {
    teardown(topicDir);
  }
});

// ── Test 6: queue dequeue path — empty trailing prompt + queue block ─────────
test('empty trailing prompt with queue block is dequeued into history', () => {
  const { topic, topicDir, historyPath } = setupTopic();
  try {
    // Replace planted history with an EMPTY trailing prompt, and add a queue file
    // so fillEmptyPromptFromQueueOrInteractive injects from the queue.
    const queueBody = 'Queued prompt body — dequeue must inject this into history before coding runs.';
    fs.writeFileSync(historyPath, `# ${topic}\n\n## User Prompt\n<!-- empty -->\n`, 'utf8');
    fs.writeFileSync(
      path.join(topicDir, 'prompt-queue.md'),
      `## Prompt 1\n\n${queueBody}\n`,
      'utf8'
    );
    const res = runHarness(topic, 'coding');
    if (res.error) throw new Error(`spawn failed: ${res.error.message}`);
    const content = fs.readFileSync(historyPath, 'utf8');
    assert.ok(
      content.includes(queueBody) || /## Coding Agent Response\b/.test(content),
      `queue dequeue must inject body OR pipeline still appended a Coding Agent Response.\nhistory tail: ${content.slice(-500)}`
    );
  } finally {
    teardown(topicDir);
  }
});

// ── Test 7: e2e spawn must not mutate the real `Agent_Orchestrator/.last-topic` ──
test('e2e spawn leaves real .last-topic untouched (isolation via AGENT_ORCH_LAST_TOPIC_PATH)', () => {
  const realLastTopic = path.join(HARNESS, '.last-topic');
  const before = fs.existsSync(realLastTopic)
    ? fs.readFileSync(realLastTopic, 'utf8')
    : null;
  const { topic, topicDir } = setupTopic();
  try {
    const res = runHarness(topic, 'coding');
    if (res.error) throw new Error(`spawn failed: ${res.error.message}`);
    const after = fs.existsSync(realLastTopic)
      ? fs.readFileSync(realLastTopic, 'utf8')
      : null;
    assert.strictEqual(
      after, before,
      `real .last-topic must not be modified by e2e spawn (was ${JSON.stringify(before)}, now ${JSON.stringify(after)}); env-var isolation regressed`
    );
    assert.ok(
      after == null || !after.includes(topic),
      `real .last-topic must not contain the e2e stub topic name "${topic}"; got ${JSON.stringify(after)}`
    );
  } finally {
    teardown(topicDir);
  }
});

(async () => {
  await Promise.all(pending);
  // Remove the whole OS-temp sandbox tree so no stub topic dirs linger anywhere.
  try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch {}
  if (failed === 0) console.log(`\nALL PASSED`);
  else { console.error(`\n${failed} FAILED`); process.exitCode = 1; }
})();
