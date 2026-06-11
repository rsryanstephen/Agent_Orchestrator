#!/usr/bin/env node
'use strict';

/**
 * Tests for Agent_Orchestrator/src/lib/providers/ (registry + claude-code concrete).
 * Run: node Agent_Orchestrator/tests/provider-registry.test.js
 *
 * (PR1) getProvider() with no args returns claude-code when global-config has no `provider` field
 * (PR2) getProvider('claude-code') returns ClaudeCodeProvider with all capabilities=true
 * (PR3) getProvider('unknown-xyz') throws an error containing a login-instructions hint
 * (PR4) global-config.json `provider` field overrides the default
 * (PR5) ClaudeCodeProvider.spawn() produces same event sequence as direct runClaude on fixture
 * (PR6) Provider base class throws on unimplemented methods
 * (PR7) ClaudeCodeProvider.parseStream() emits correct normalised events for fixture JSONL lines
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const HARNESS = path.join(__dirname, '..');
const registryPath = path.join(HARNESS, 'src', 'lib', 'providers', 'registry.js');
const claudeCodePath = path.join(HARNESS, 'src', 'lib', 'providers', 'claude-code.js');
const providerBasePath = path.join(HARNESS, 'src', 'lib', 'providers', 'Provider.js');
const globalConfigPath = path.join(HARNESS, 'global-config.json');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function withTempGlobalConfig(providerField, fn) {
  const original = fs.readFileSync(globalConfigPath, 'utf8');
  try {
    const cfg = JSON.parse(original);
    if (providerField === null) {
      delete cfg.provider;
    } else {
      cfg.provider = providerField;
    }
    fs.writeFileSync(globalConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
    // Clear require cache so registry re-reads the file.
    delete require.cache[registryPath];
    fn(require(registryPath));
  } finally {
    fs.writeFileSync(globalConfigPath, original, 'utf8');
    delete require.cache[registryPath];
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('(PR1) getProvider() with no args returns claude-code by default', () => {
  withTempGlobalConfig(null, ({ getProvider }) => {
    const p = getProvider();
    assert.strictEqual(p.id, 'claude-code', 'default provider id must be "claude-code"');
  });
});

test('(PR2) getProvider("claude-code") has all capabilities true', () => {
  delete require.cache[registryPath];
  const { getProvider } = require(registryPath);
  const p = getProvider('claude-code');
  assert.strictEqual(p.id, 'claude-code');
  const caps = p.capabilities;
  for (const key of ['planMode', 'skillsRuntime', 'subAgents', 'autoResume', 'streamJson', 'hooks', 'permissionMode']) {
    assert.strictEqual(caps[key], true, `capabilities.${key} must be true`);
  }
});

test('(PR3) getProvider("unknown-xyz") throws with hint', () => {
  delete require.cache[registryPath];
  const { getProvider } = require(registryPath);
  assert.throws(
    () => getProvider('unknown-xyz'),
    err => {
      assert.ok(/unknown-xyz/i.test(err.message), 'error must mention the bad id');
      assert.ok(/global-config\.json/i.test(err.message), 'error must hint at global-config.json');
      return true;
    }
  );
});

test('(PR4) global-config.json `provider` field is respected', () => {
  withTempGlobalConfig('claude-code', ({ getProvider }) => {
    const p = getProvider();
    assert.strictEqual(p.id, 'claude-code', 'provider from config must resolve to claude-code');
  });
});

testAsync('(PR6) Provider base class throws on all unimplemented methods', async () => {
  delete require.cache[providerBasePath];
  const Provider = require(providerBasePath);
  const p = new Provider();
  // Synchronous getter/method throws
  assert.throws(() => p.id, /Not implemented/);
  assert.throws(() => p.loginInstructions(), /Not implemented/);
  // Async methods return rejected promises
  await assert.rejects(() => p.probe(), /Not implemented/);
  await assert.rejects(() => p.spawn('x'), /Not implemented/);
  for (const key of ['planMode', 'skillsRuntime', 'subAgents', 'autoResume', 'streamJson', 'hooks', 'permissionMode']) {
    assert.strictEqual(p.capabilities[key], false, `base capabilities.${key} must default false`);
  }
});

test('(PR7) ClaudeCodeProvider.parseStream() emits correct normalised events', () => {
  delete require.cache[claudeCodePath];
  const ClaudeCodeProvider = require(claudeCodePath);
  const p = new ClaudeCodeProvider();

  // assistant_text event
  const assistantLine = JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Hello world' }] },
  });
  const ev1 = p.parseStream(assistantLine);
  assert.strictEqual(ev1.type, 'assistant_text');
  assert.strictEqual(ev1.text, 'Hello world');
  assert.ok(ev1.usage, 'usage must be populated');

  // done event (result)
  const resultLine = JSON.stringify({ type: 'result', cost_usd: 0.001234, usage: { input_tokens: 10, output_tokens: 5 } });
  const ev2 = p.parseStream(resultLine);
  assert.strictEqual(ev2.type, 'done');
  assert.strictEqual(ev2.costUsd, 0.001234);

  // init event
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' });
  const ev3 = p.parseStream(initLine);
  assert.strictEqual(ev3.type, 'init');
  assert.strictEqual(ev3.model, 'claude-sonnet-4-6');

  // non-JSON returns null
  const ev4 = p.parseStream('not-json');
  assert.strictEqual(ev4, null);

  // empty string returns null
  const ev5 = p.parseStream('');
  assert.strictEqual(ev5, null);
});

// (PR5) spawn() event sequence test — uses a stub that replaces the 'claude' binary spawn
// with an in-process mock emitting the same stream-json event sequence runClaude expects.
testAsync('(PR5) ClaudeCodeProvider.spawn() produces same event sequence as runClaude fixture', async () => {
  delete require.cache[claudeCodePath];
  const ClaudeCodeProvider = require(claudeCodePath);

  // Fixture JSONL stream (mirrors what claude CLI emits with --output-format stream-json).
  const FIXTURE_LINES = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 20, output_tokens: 8 }, content: [{ type: 'text', text: 'fixture response text' }] } }),
    JSON.stringify({ type: 'result', cost_usd: 0.000042, usage: { input_tokens: 20, output_tokens: 8 } }),
  ].join('\n') + '\n';

  // Must patch child_process.spawn BEFORE requiring the provider module,
  // because the module destructures spawn at load time.
  const cp = require('child_process');
  const origSpawn = cp.spawn;
  cp.spawn = (_cmd, _args, _opts) => {
    const stub = new EventEmitter();
    stub.stdin = { write: () => {}, end: () => {} };
    stub.stdout = new EventEmitter();
    stub.stderr = new EventEmitter();
    // Emit fixture data async so event handlers are attached first.
    setImmediate(() => {
      stub.stdout.emit('data', Buffer.from(FIXTURE_LINES));
      stub.emit('close', 0);
    });
    return stub;
  };

  // Re-require after patching so the destructured spawn binding picks up the stub.
  delete require.cache[claudeCodePath];
  const ClaudeCodeProvider2 = require(claudeCodePath);

  try {
    const p = new ClaudeCodeProvider2();
    const result = await p.spawn('test prompt', {
      silent: true,
      modelArgs: ['--model', 'claude-sonnet-4-6'],
      effortEnv: {},
      maxAttempts: 1,
    });
    assert.strictEqual(result.text, 'fixture response text', 'text must equal fixture assistant text block');
    assert.strictEqual(result.model, 'claude-sonnet-4-6', 'model must be detected from init event');
    assert.ok(result.usage, 'usage must be populated from result event');
    assert.strictEqual(result.costUsd, 0.000042, 'costUsd must be parsed from result event');
  } finally {
    cp.spawn = origSpawn;
    delete require.cache[claudeCodePath];
  }
});

// ── summary ───────────────────────────────────────────────────────────────────

process.on('exit', () => {
  if (_failed > 0) console.error(`\n${_failed} test(s) FAILED`);
  else console.log('\nAll provider-registry tests PASSED');
});
