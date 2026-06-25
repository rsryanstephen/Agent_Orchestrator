#!/usr/bin/env node
'use strict';

// Regression test: the pipeline-completion chime (tada.wav) must NOT burst once
// per stubbed harness dispatch.
//
// One guard in run-agent.js enforces this:
//   1. _playSoundFile early-returns when the module-level `topic` starts with
//      `__e2e_stub` — stub e2e dispatches spin up many short-lived processes,
//      each previously hitting the post-drain pending===0 gate and firing
//      tada.wav (the repeated burst in .state/auto-resume.log:591-639).
//
// (A once-per-process completion latch was tried and removed: the sole call site
// already fires once per dispatch after the in-process drain returns empty, and a
// never-resetting latch would permanently silence a legitimate second completion
// in a long-lived/re-dispatch process.)
//
// This is asserted at SOURCE level: run-agent.js `return`s at require time
// (require.main !== module, :1728), so `topic`/`config` are never initialised and
// live in the TDZ — calling the gated paths via require() throws before reaching
// the guard, so behavioural invocation can't observe it. Source assertions are
// the repo convention for this.
// Run: node Agent_Orchestrator/tests/completion-chime-suppressed-for-e2e-topic.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'run-agent.js'), 'utf8');

test('_playSoundFile early-returns for __e2e_stub topics', () => {
  assert.ok(
    /if\s*\(\s*typeof topic === 'string' && topic\.startsWith\('__e2e_stub'\)\s*\)\s*return;/.test(SRC),
    'expected an __e2e_stub early-return guard in _playSoundFile',
  );
  // Guard must sit AFTER the child/broker env guard and BEFORE the master gate.
  const envGuard = SRC.indexOf("process.env.AGENT_ORCH_BROKERED_CHILD) return;");
  const e2eGuard = SRC.indexOf("topic.startsWith('__e2e_stub')");
  const masterGate = SRC.indexOf("'play-notification-sound', true)");
  assert.ok(envGuard !== -1 && e2eGuard !== -1 && masterGate !== -1, 'all three landmarks present');
  assert.ok(envGuard < e2eGuard && e2eGuard < masterGate, 'e2e guard between env guard and master gate');
});

test('playCompletionSound delegates without a never-resetting latch', () => {
  // The redundant once-per-process latch was removed; guard against its return.
  assert.ok(
    !/_completionChimePlayed/.test(SRC),
    'the removed _completionChimePlayed latch must not be reintroduced',
  );
  assert.ok(
    /function playCompletionSound\(\)\s*\{[\s\S]*?_playSoundFile\('completion-sound-file', 'tada\.wav'\);[\s\S]*?\}/.test(SRC),
    'expected playCompletionSound to delegate to _playSoundFile',
  );
});

test('completion-chime gate is hold-aware: uses parseQueue not queueLength', () => {
  // Bug: queueLength() counts ALL blocks including held ones. When remaining
  // blocks are all on hold, chime was incorrectly suppressed. Fix uses parseQueue
  // and filters to only unheld blocks before deciding whether to chime.
  assert.ok(
    !/_postDrainPending/.test(SRC),
    'old queueLength-based _postDrainPending variable must not remain in chime gate',
  );
  assert.ok(
    /promptQueue\.parseQueue\(topicDirPath\(\)\)/.test(SRC),
    'chime gate must call parseQueue (hold-aware) not queueLength',
  );
  assert.ok(
    /_postDrainBlocks\.filter\(b => !b\.held\)\.length/.test(SRC),
    'chime gate must filter out held blocks before checking count',
  );
  assert.ok(
    /_postDrainUnheld === 0/.test(SRC),
    'chime gate must fire when unheld count is 0 (all-held or empty both qualify)',
  );
  // Skipped-chime log must reference unheld, not pending.
  assert.ok(
    /unheld=\$\{_postDrainUnheld\}/.test(SRC),
    'skipped-chime log must show unheld count not pending count',
  );
});
