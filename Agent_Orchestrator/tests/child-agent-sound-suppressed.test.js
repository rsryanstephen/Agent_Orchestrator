#!/usr/bin/env node
'use strict';

// Regression test: parallel-queue child agents (spawned with
// AGENT_ORCH_TOPIC_DIR_OVERRIDE set, see config-utils.js:261) must NOT emit any
// of the five notification sounds. _playSoundFile gates on that env var as its
// first statement, so with the override set it returns BEFORE touching any
// module sound state. Without the override (parent orchestrator) it proceeds
// past the guard — proving the parent path is unaffected.
// Run: node Agent_Orchestrator/tests/child-agent-sound-suppressed.test.js

const assert = require('assert');
const { _playSoundFile } = require('../src/run-agent');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

const ENV_KEY = 'AGENT_ORCH_TOPIC_DIR_OVERRIDE';

test('child agent (override set) suppresses sound — early return, no throw', () => {
  const prev = process.env[ENV_KEY];
  process.env[ENV_KEY] = '.parallel/some-slug-0';
  try {
    assert.strictEqual(
      _playSoundFile('queue-fetch-sound-file', 'x.wav', [[1, 1]]),
      undefined,
      'with override set, _playSoundFile must short-circuit to undefined',
    );
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = prev;
  }
});

const BROKERED_KEY = 'AGENT_ORCH_BROKERED_CHILD';

test('brokered child (broker flag set) suppresses sound — early return, no throw', () => {
  // Regression: multi-topic `hrun 1-caf 2-f` runs each topic as a concurrent
  // broker child WITHOUT the topic-dir override, so each child used to fire its
  // own chimes while all were busy. The broker now tags children with
  // AGENT_ORCH_BROKERED_CHILD and _playSoundFile must short-circuit on it.
  const prevOverride = process.env[ENV_KEY];
  const prevBrokered = process.env[BROKERED_KEY];
  delete process.env[ENV_KEY];
  process.env[BROKERED_KEY] = '1';
  try {
    assert.strictEqual(
      _playSoundFile('completion-sound-file', 'x.wav', [[1, 1]]),
      undefined,
      'with broker flag set, _playSoundFile must short-circuit to undefined',
    );
  } finally {
    if (prevOverride === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = prevOverride;
    if (prevBrokered === undefined) delete process.env[BROKERED_KEY]; else process.env[BROKERED_KEY] = prevBrokered;
  }
});

test('parent agent (no child flags) proceeds past guard — sound path reached', () => {
  const prevOverride = process.env[ENV_KEY];
  const prevBrokered = process.env[BROKERED_KEY];
  delete process.env[ENV_KEY];
  delete process.env[BROKERED_KEY];
  try {
    // Without either child flag, execution advances past the early-return guard
    // into the sound-playback body (which references module dispatch state not
    // initialised when this file is require()d for testing). Reaching that body
    // is the proof the parent path is NOT muted by the guard.
    assert.throws(() => _playSoundFile('queue-fetch-sound-file', 'x.wav', [[1, 1]]));
  } finally {
    if (prevOverride === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = prevOverride;
    if (prevBrokered === undefined) delete process.env[BROKERED_KEY]; else process.env[BROKERED_KEY] = prevBrokered;
  }
});
