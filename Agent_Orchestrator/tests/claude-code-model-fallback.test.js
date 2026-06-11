#!/usr/bin/env node
'use strict';

/**
 * Integration test: ClaudeCodeProvider.spawn() detects "model unavailable" CLI
 * failures, falls back ONCE to LATEST_SONNET, and does NOT consume the 5-attempt
 * transient-retry budget when stderr coincidentally contains a 5xx substring.
 *
 * Run: node Agent_Orchestrator/tests/claude-code-model-fallback.test.js
 */

const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');

const HARNESS = path.join(__dirname, '..');

let _failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log('PASS', name))
    .catch(e => { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; });
}

// ── Stub child_process.spawn ───────────────────────────────────────────────
// Each invocation pulls a script from the queue and emits its stderr/exit.
const spawnCalls = [];
let spawnQueue = [];

function makeFakeChild({ stderr = '', stdout = '', code = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  setImmediate(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    setImmediate(() => child.emit('close', code));
  });
  return child;
}

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'child_process') {
    const real = originalLoad.apply(this, arguments);
    return {
      ...real,
      spawn(cmd, args, opts) {
        spawnCalls.push({ cmd, args: [...args], opts });
        const script = spawnQueue.shift() || { code: 0, stdout: '{"type":"result","stop_reason":"end_turn"}\n' };
        return makeFakeChild(script);
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const ClaudeCodeProvider = require(path.join(HARNESS, 'src', 'lib', 'providers', 'claude-code.js'));

async function runOne({ scripts, opts = {} }) {
  spawnCalls.length = 0;
  spawnQueue = scripts.slice();
  const provider = new ClaudeCodeProvider();
  const result = await provider.spawn('hello', {
    silent: true,
    streamOutput: false,
    heartbeatMs: 60000,
    prespawnHeartbeatMs: 60000,
    cliWatchdogMs: 60000,
    backoffMs: [1, 1, 1, 1, 1],
    ...opts,
  });
  return { result, spawnCalls: spawnCalls.slice() };
}

(async () => {
  const CANARY = 'Error: selected model (gpt-5) may not exist or you may not have access. Run --model to pick a different model.\n';
  const NOISY_5XX_BEFORE_CANARY = `503 service unavailable\n${CANARY}`;

  await test('CMF1 — model-unavailable triggers ONE Sonnet fallback (no retry storm)', async () => {
    const { result, spawnCalls: calls } = await runOne({
      scripts: [
        { code: 1, stderr: NOISY_5XX_BEFORE_CANARY },
        { code: 0, stdout: '{"type":"result","stop_reason":"end_turn","result":"ok"}\n' },
      ],
      opts: { modelArgs: ['--model', 'gpt-5'], maxAttempts: 5 },
    });
    assert.strictEqual(calls.length, 2, `expected exactly 2 spawn calls (failing + fallback), got ${calls.length}`);
    const fbArgs = calls[1].args;
    const modelIdx = fbArgs.indexOf('--model');
    assert.strictEqual(fbArgs[modelIdx + 1], 'claude-sonnet-4-6', 'fallback must spawn with claude-sonnet-4-6');
    assert.ok(result && /unavailable.*fell back to claude-sonnet-4-6/.test(result.fallbackNote || ''),
      `fallbackNote must mention substitution, got: ${result && result.fallbackNote}`);
  });

  await test('CMF2 — both attempts fail -> actionable non-transient error message', async () => {
    let threw = null;
    try {
      await runOne({
        scripts: [
          { code: 1, stderr: CANARY },
          { code: 1, stderr: CANARY },
        ],
        opts: { modelArgs: ['--model', 'gpt-5'], maxAttempts: 5 },
      });
    } catch (e) { threw = e; }
    assert.ok(threw, 'must throw when fallback also fails');
    assert.ok(/unavailable for this account\/provider/.test(threw.message),
      `error must be actionable, got: ${threw.message}`);
    assert.strictEqual(threw.transientError, false, 'must not be marked transient');
  });

  console.log(_failed === 0 ? '\nAll passed.' : `\n${_failed} failed.`);
  if (_failed > 0) process.exit(1);
})();
