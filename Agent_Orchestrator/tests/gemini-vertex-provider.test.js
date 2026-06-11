#!/usr/bin/env node
'use strict';

// Unit tests for gemini-vertex.js provider.
// Run: node Agent_Orchestrator/tests/gemini-vertex-provider.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const provider = require('../src/lib/providers/gemini-vertex');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); _failed++; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-vertex-test-'));
}

function writeJsonl(dir, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dir, 'run.jsonl'), lines + '\n', 'utf8');
}

// ── Provider id ────────────────────────────────────────────────────────────────

// Requirement: gemini-vertex provider has id='gemini-vertex' separate from 'gemini'
test('GV1: id is gemini-vertex', () => {
  assert.strictEqual(provider.id, 'gemini-vertex');
});

// ── Capabilities ───────────────────────────────────────────────────────────────

// Requirement: gemini-vertex has same capability profile as gemini (mcp+tools, rest false)
test('GV2: capabilities match gemini profile', () => {
  assert.strictEqual(provider.capabilities.mcp, true);
  assert.strictEqual(provider.capabilities.tools, true);
  assert.strictEqual(provider.capabilities.planMode, false);
  assert.strictEqual(provider.capabilities.skillsRuntime, false);
  assert.strictEqual(provider.capabilities.subAgents, false);
  assert.strictEqual(provider.capabilities.autoResume, false);
  assert.strictEqual(provider.capabilities.streamJson, false);
  assert.strictEqual(provider.capabilities.hooks, false);
  assert.strictEqual(provider.capabilities.permissionMode, false);
});

test('GV3: supportsFeature(mcp)=true, supportsFeature(autoResume)=false', () => {
  assert.strictEqual(provider.supportsFeature('mcp'), true);
  assert.strictEqual(provider.supportsFeature('autoResume'), false);
  assert.strictEqual(provider.supportsFeature('nonexistent'), false);
});

// ── loginInstructions ─────────────────────────────────────────────────────────

// Requirement: loginInstructions covers Vertex AI ADC setup steps
test('GV4: loginInstructions mentions GOOGLE_CLOUD_PROJECT', () => {
  const s = provider.loginInstructions();
  assert.ok(typeof s === 'string');
  assert.ok(s.includes('GOOGLE_CLOUD_PROJECT'), 'must mention GOOGLE_CLOUD_PROJECT');
});

test('GV5: loginInstructions mentions ADC gcloud command', () => {
  const s = provider.loginInstructions();
  assert.ok(s.includes('gcloud auth application-default login'), 'must mention gcloud ADC command');
});

test('GV6: loginInstructions mentions aiplatform or Vertex AI', () => {
  const s = provider.loginInstructions();
  assert.ok(
    s.includes('aiplatform') || s.includes('Vertex AI') || s.includes('vertex'),
    'must mention Vertex AI'
  );
});

// ── probe: returns false when GOOGLE_CLOUD_PROJECT unset ──────────────────────

// Requirement: probe() returns false and warns when GOOGLE_CLOUD_PROJECT absent
test('GV7: probe returns false when GOOGLE_CLOUD_PROJECT not set', () => {
  const saved = process.env.GOOGLE_CLOUD_PROJECT;
  try {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const result = provider.probe();
    assert.strictEqual(result, false, 'probe must return false without GOOGLE_CLOUD_PROJECT');
  } finally {
    if (saved !== undefined) process.env.GOOGLE_CLOUD_PROJECT = saved;
    else delete process.env.GOOGLE_CLOUD_PROJECT;
  }
});

// ── parseStream ───────────────────────────────────────────────────────────────

// Requirement: parseStream normalizes events same as gemini.js (shared JSONL parser)
test('GV8: parseStream: spawn failure -> error + done', () => {
  const events = provider.parseStream(1, '/nonexistent-xyz-vertex', 'spawn failed');
  assert.ok(events.some(e => e.type === 'error'));
  assert.ok(events.some(e => e.type === 'done'));
  const err = events.find(e => e.type === 'error');
  assert.strictEqual(err.content.code, 'error_spawn');
});

test('GV9: parseStream: stdout fallback when log dir empty', () => {
  const tmpDir = makeTmpDir();
  try {
    const events = provider.parseStream(0, tmpDir, '', 'plain text answer from vertex');
    assert.ok(events.some(e => e.type === 'assistant_text'));
    const textEv = events.find(e => e.type === 'assistant_text');
    assert.strictEqual(textEv.content.text, 'plain text answer from vertex');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('GV10: parseStream: JSONL log entries -> normalized events', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'message', text: 'Vertex response' },
      { type: 'usage', input_tokens: 100, output_tokens: 50 },
    ]);
    const events = provider.parseStream(0, tmpDir, '');
    assert.ok(events.some(e => e.type === 'assistant_text'));
    assert.ok(events.some(e => e.type === 'usage'));
    assert.ok(events.some(e => e.type === 'done'));
    const textEv = events.find(e => e.type === 'assistant_text');
    assert.strictEqual(textEv.content.text, 'Vertex response');
    const usageEv = events.find(e => e.type === 'usage');
    assert.strictEqual(usageEv.content.input_tokens, 100);
    assert.strictEqual(usageEv.content.output_tokens, 50);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('GV11: parseStream: auth error in stderr -> error_auth code', () => {
  const tmpDir = makeTmpDir();
  try {
    const events = provider.parseStream(1, tmpDir, '401 unauthorized: ADC credentials missing');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, 'must have error event');
    assert.strictEqual(err.content.code, 'error_auth');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('GV12: parseStream: all events have numeric ts', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [{ type: 'message', text: 'Hi' }]);
    const events = provider.parseStream(0, tmpDir, '');
    for (const e of events) {
      assert.ok(typeof e.ts === 'number', `event ${e.type} missing numeric ts`);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('GV13: parseStream: done is always last event', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [{ type: 'message', text: 'ok' }]);
    const events = provider.parseStream(0, tmpDir, '');
    assert.strictEqual(events[events.length - 1].type, 'done');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── registry integration ───────────────────────────────────────────────────────

// Requirement: registry resolves 'gemini-vertex' id to adapted provider
test('GV14: registry resolves gemini-vertex', () => {
  const { getProvider } = require('../src/lib/providers/registry');
  const p = getProvider('gemini-vertex');
  assert.ok(p, 'getProvider must return something');
  assert.strictEqual(p.id, 'gemini-vertex');
  assert.ok(typeof p.spawn === 'function');
  assert.ok(typeof p.probe === 'function');
  assert.ok(typeof p.loginInstructions === 'function');
});

// Requirement: unknown provider error message lists gemini-vertex as known option
test('GV15: unknown provider error lists gemini-vertex', () => {
  const { getProvider } = require('../src/lib/providers/registry');
  try {
    getProvider('no-such-provider-xyz');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('gemini-vertex'), 'error must list gemini-vertex as known provider');
  }
});

// ── Summary ────────────────────────────────────────────────────────────────────

if (_failed > 0) {
  console.error(`\n${_failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
