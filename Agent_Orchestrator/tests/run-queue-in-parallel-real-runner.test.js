#!/usr/bin/env node
'use strict';

// Behavioral test for `run-queue-in-parallel` (QA FAIL #1 — was a stub).
// Drives runParallelQueueBatch end-to-end with the REAL spawn runner
// (makeSpawnRunner) pointed at a fake child `run-agent.js` that honours
// AGENT_ORCH_TOPIC_DIR_OVERRIDE. Asserts: ≥2 non-hold blocks drain via real
// child processes, every child body + response lands in the main history,
// the `(hold)` block is NOT dispatched, and no stub placeholder survives.
// Run: node Agent_Orchestrator/tests/run-queue-in-parallel-real-runner.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parallelBatch = require('../src/lib/parallel-batch');

function test(name, fn) {
  Promise.resolve().then(fn)
    .then(() => console.log('PASS', name))
    .catch(e => { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; });
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rqip-'));
}

// Fake child: appends a deterministic Coding Agent Response into the override
// dir's `<topic>.md`, simulating a real run-agent.js child without a provider.
function writeFakeChild(dir) {
  const p = path.join(dir, 'fake-run-agent.js');
  fs.writeFileSync(p, [
    "const fs=require('fs');const path=require('path');",
    "const d=process.env.AGENT_ORCH_TOPIC_DIR_OVERRIDE;",
    "const topic=process.argv[2];",
    "fs.appendFileSync(path.join(d, topic+'.md'), `## Coding Agent Response\\n\\n- handled ${topic}\\n`);",
  ].join('\n'), 'utf8');
  return p;
}

test('real spawn runner drains non-hold blocks into history, skips (hold), no stub text', async () => {
  const tmp = mkTmp();
  const topicDir = path.join(tmp, 'topic');
  fs.mkdirSync(topicDir, { recursive: true });
  const historyPath = path.join(topicDir, 'topic.md');
  fs.writeFileSync(historyPath, '# topic history\n', 'utf8');
  const topicConfigPath = path.join(topicDir, 'topic-config.json');
  fs.writeFileSync(topicConfigPath, JSON.stringify({ models: {} }), 'utf8');
  const fakeChild = writeFakeChild(tmp);

  const blocks = [
    { body: 'first parallel task body', header: 'all', slug: 'alpha', held: false },
    { body: 'second parallel task body', header: 'all', slug: 'beta', held: false },
    { body: 'held task body', header: 'all', slug: 'gamma', held: true },
  ];

  const res = await parallelBatch.runParallelQueueBatch({
    topicDir,
    topicName: 'topic',
    historyPath,
    blocks,
    maxParallel: 2,
    slotsDir: path.join(tmp, 'slots'),
    runner: parallelBatch.makeSpawnRunner({
      execPath: process.execPath,
      runAgentPath: fakeChild,
      pipelineShort: 'all',
      parentTopicConfigPath: topicConfigPath,
    }),
  });

  assert.strictEqual(res.dispatched, 2, 'only the 2 non-hold blocks dispatched');
  assert.strictEqual(res.hold.length, 1, '(hold) block returned untouched for serial path');

  const hist = fs.readFileSync(historyPath, 'utf8');
  assert.ok(hist.includes('first parallel task body'), 'first prompt body present');
  assert.ok(hist.includes('second parallel task body'), 'second prompt body present');
  assert.ok(hist.includes('- handled alpha'), 'alpha child response spliced');
  assert.ok(hist.includes('- handled beta'), 'beta child response spliced');
  assert.ok(!hist.includes('held task body'), 'held block not dispatched');
  assert.ok(!/parallel agent stub/.test(hist), 'no stub placeholder in history');

  fs.rmSync(tmp, { recursive: true, force: true });
});
