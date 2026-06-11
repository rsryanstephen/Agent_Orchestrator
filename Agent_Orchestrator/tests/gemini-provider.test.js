#!/usr/bin/env node
'use strict';

// Unit tests for gemini.js provider.
// Run: node Agent_Orchestrator/tests/gemini-provider.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const provider = require('../src/lib/providers/gemini');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); _failed++; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
}

function writeJsonl(dir, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dir, 'run.jsonl'), lines + '\n', 'utf8');
}

// ── Capabilities ───────────────────────────────────────────────────────────────

test('capabilities: MCP + tools enabled, all others disabled', () => {
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

test('supportsFeature: mcp=true, autoResume=false', () => {
  assert.strictEqual(provider.supportsFeature('mcp'), true);
  assert.strictEqual(provider.supportsFeature('autoResume'), false);
  assert.strictEqual(provider.supportsFeature('nonexistent'), false);
});

// ── loginInstructions ─────────────────────────────────────────────────────────

test('loginInstructions contains expected keywords', () => {
  const s = provider.loginInstructions();
  assert.ok(typeof s === 'string', 'must be string');
  assert.ok(s.includes('gemini-cli') || s.includes('@google/gemini-cli'), 'must mention gemini-cli package');
  assert.ok(s.includes('gemini auth') || s.includes('GEMINI_API_KEY'), 'must mention auth method');
  assert.ok(s.includes('gemini --version'), 'must mention verification command');
});

// ── _parseGeminiLogEntry ───────────────────────────────────────────────────────

const parse = provider._parseGeminiLogEntry;

test('_parseGeminiLogEntry: null/empty/unknown returns null', () => {
  assert.strictEqual(parse(null), null);
  assert.strictEqual(parse({}), null);
  assert.strictEqual(parse({ type: 'unknown_xyz' }), null);
  assert.strictEqual(parse('string'), null);
});

test('_parseGeminiLogEntry: assistant_text from type=message', () => {
  const r = parse({ type: 'message', text: 'Hello world' });
  assert.strictEqual(r.kind, 'assistant_text');
  assert.strictEqual(r.text, 'Hello world');
});

test('_parseGeminiLogEntry: assistant_text from type=assistant', () => {
  const r = parse({ type: 'assistant', content: 'Plan complete.' });
  assert.strictEqual(r.kind, 'assistant_text');
  assert.strictEqual(r.text, 'Plan complete.');
});

test('_parseGeminiLogEntry: assistant_text preserves model field', () => {
  const r = parse({ type: 'message', text: 'Hi', model: 'gemini-2.0-flash' });
  assert.strictEqual(r.kind, 'assistant_text');
  assert.strictEqual(r.model, 'gemini-2.0-flash');
});

test('_parseGeminiLogEntry: tool_call from type=tool_call', () => {
  const r = parse({ type: 'tool_call', id: 'tc1', name: 'Read', input: { file_path: '/foo.txt' } });
  assert.strictEqual(r.kind, 'tool_call');
  assert.strictEqual(r.id, 'tc1');
  assert.strictEqual(r.name, 'Read');
  assert.deepStrictEqual(r.input, { file_path: '/foo.txt' });
});

test('_parseGeminiLogEntry: tool_call from type=tool_use', () => {
  const r = parse({ type: 'tool_use', id: 'tu1', name: 'Write', input: { content: 'x' } });
  assert.strictEqual(r.kind, 'tool_call');
  assert.strictEqual(r.name, 'Write');
});

test('_parseGeminiLogEntry: tool_call from type=function_call', () => {
  const r = parse({ type: 'function_call', name: 'Bash', arguments: { command: 'ls' } });
  assert.strictEqual(r.kind, 'tool_call');
  assert.strictEqual(r.name, 'Bash');
});

test('_parseGeminiLogEntry: tool_result from type=tool_result', () => {
  const r = parse({ type: 'tool_result', call_id: 'tc1', output: 'line1\nline2', is_error: false });
  assert.strictEqual(r.kind, 'tool_result');
  assert.strictEqual(r.call_id, 'tc1');
  assert.strictEqual(r.output, 'line1\nline2');
  assert.strictEqual(r.is_error, false);
});

test('_parseGeminiLogEntry: tool_result from type=tool_response', () => {
  const r = parse({ type: 'tool_response', id: 'tr1', result: 'ok' });
  assert.strictEqual(r.kind, 'tool_result');
  assert.ok(r.output !== undefined);
});

test('_parseGeminiLogEntry: tool_result truncates at 64KB', () => {
  const bigOutput = 'x'.repeat(70000);
  const r = parse({ type: 'tool_result', output: bigOutput });
  assert.ok(r.output.endsWith('[TRUNCATED]'), 'must append [TRUNCATED]');
  assert.ok(r.output.length <= 65536 + '[TRUNCATED]'.length);
});

test('_parseGeminiLogEntry: usage from type=usage', () => {
  const r = parse({ type: 'usage', input_tokens: 100, output_tokens: 50 });
  assert.strictEqual(r.kind, 'usage');
  assert.strictEqual(r.input_tokens, 100);
  assert.strictEqual(r.output_tokens, 50);
});

test('_parseGeminiLogEntry: usage accepts prompt_tokens / completion_tokens aliases', () => {
  const r = parse({ type: 'token_usage', prompt_tokens: 200, completion_tokens: 80 });
  assert.strictEqual(r.kind, 'usage');
  assert.strictEqual(r.input_tokens, 200);
  assert.strictEqual(r.output_tokens, 80);
});

test('_parseGeminiLogEntry: error_quota from type=quota_exceeded', () => {
  const r = parse({ type: 'quota_exceeded', message: 'Quota reached' });
  assert.strictEqual(r.kind, 'error_quota');
  assert.ok(r.message.includes('Quota reached'));
});

test('_parseGeminiLogEntry: error_quota from type=rate_limit_exceeded', () => {
  const r = parse({ type: 'rate_limit_exceeded', message: 'Rate limited' });
  assert.strictEqual(r.kind, 'error_quota');
});

test('_parseGeminiLogEntry: error_quota from type=error with quota message', () => {
  const r = parse({ type: 'error', message: 'quota exhausted for this period' });
  assert.strictEqual(r.kind, 'error_quota');
});

test('_parseGeminiLogEntry: error with auth 401', () => {
  const r = parse({ type: 'error', message: '401 unauthorized' });
  assert.strictEqual(r.kind, 'error');
  assert.strictEqual(r.code, 'error_auth');
});

test('_parseGeminiLogEntry: generic error', () => {
  const r = parse({ type: 'error', message: 'something went wrong' });
  assert.strictEqual(r.kind, 'error');
  assert.ok(r.message.includes('something went wrong'));
});

// ── _readLogDirJsonl ───────────────────────────────────────────────────────────

const readDir = provider._readLogDirJsonl;

test('_readLogDirJsonl: nonexistent dir returns empty array', () => {
  const result = readDir('/nonexistent-dir-xyz-gemini');
  assert.deepStrictEqual(result, []);
});

test('_readLogDirJsonl: reads entries from .jsonl file', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'message', text: 'Hi' },
      { type: 'usage', input_tokens: 10, output_tokens: 5 },
    ]);
    const entries = readDir(tmpDir);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].type, 'message');
    assert.strictEqual(entries[1].type, 'usage');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('_readLogDirJsonl: skips malformed JSON lines', () => {
  const tmpDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(tmpDir, 'run.jsonl'),
      '{"type":"message","text":"ok"}\n{bad json}\n{"type":"usage","input_tokens":1}\n',
      'utf8');
    const entries = readDir(tmpDir);
    assert.strictEqual(entries.length, 2);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('_readLogDirJsonl: skips empty lines', () => {
  const tmpDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(tmpDir, 'run.jsonl'),
      '\n\n{"type":"message","text":"hi"}\n\n',
      'utf8');
    const entries = readDir(tmpDir);
    assert.strictEqual(entries.length, 1);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('_readLogDirJsonl: reads multiple .jsonl files sorted', () => {
  const tmpDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(tmpDir, 'a.jsonl'), '{"type":"message","text":"first"}\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'b.jsonl'), '{"type":"message","text":"second"}\n', 'utf8');
    const entries = readDir(tmpDir);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].text, 'first');
    assert.strictEqual(entries[1].text, 'second');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── parseStream (full JSONL fixture) ─────────────────────────────────────────

test('parseStream: full JSONL fixture -> expected event sequence', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'message', text: 'Analyzing your request...' },
      { type: 'tool_call', id: 'tc1', name: 'Read', input: { file_path: '/src/foo.js' } },
      { type: 'tool_result', call_id: 'tc1', output: 'const x = 1;', is_error: false },
      { type: 'message', text: 'Done. Here is the fix.' },
      { type: 'usage', input_tokens: 200, output_tokens: 80 },
    ]);

    const events = provider.parseStream(0, tmpDir, '');
    const types = events.map(e => e.type);

    assert.ok(types.includes('assistant_text'), 'must have assistant_text');
    assert.ok(types.includes('tool_call'), 'must have tool_call');
    assert.ok(types.includes('tool_result'), 'must have tool_result');
    assert.ok(types.includes('usage'), 'must have usage');
    assert.ok(types.includes('done'), 'must have done');

    const textEvents = events.filter(e => e.type === 'assistant_text');
    assert.strictEqual(textEvents.length, 2, 'two text messages');
    assert.strictEqual(textEvents[0].content.text, 'Analyzing your request...');
    assert.strictEqual(textEvents[1].content.text, 'Done. Here is the fix.');

    const toolCall = events.find(e => e.type === 'tool_call');
    assert.strictEqual(toolCall.content.id, 'tc1');
    assert.strictEqual(toolCall.content.name, 'Read');
    assert.deepStrictEqual(toolCall.content.input, { file_path: '/src/foo.js' });

    const toolResult = events.find(e => e.type === 'tool_result');
    assert.strictEqual(toolResult.content.call_id, 'tc1');
    assert.strictEqual(toolResult.content.output, 'const x = 1;');
    assert.strictEqual(toolResult.content.is_error, false);

    const usageEvent = events.find(e => e.type === 'usage');
    assert.strictEqual(usageEvent.content.input_tokens, 200);
    assert.strictEqual(usageEvent.content.output_tokens, 80);
    assert.strictEqual(usageEvent.content.cache_read_tokens, null);
    assert.strictEqual(usageEvent.content.cache_write_tokens, null);
    assert.strictEqual(usageEvent.content.cost_usd, null);

    const doneEvent = events.find(e => e.type === 'done');
    assert.strictEqual(doneEvent.content.exit_code, 0);
    assert.strictEqual(doneEvent.content.session_id, null);

    assert.strictEqual(types[types.length - 1], 'done', 'done must be last event');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('parseStream: non-zero exit + no log dir -> error + done', () => {
  const events = provider.parseStream(1, '/nonexistent-dir-xyz-gemini', 'spawn failed: ENOENT');
  assert.ok(events.some(e => e.type === 'error'), 'must have error');
  assert.ok(events.some(e => e.type === 'done'), 'must have done');
  const err = events.find(e => e.type === 'error');
  assert.strictEqual(err.content.code, 'error_spawn');
});

test('parseStream: quota_exceeded entry -> error event with code error_quota', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'message', text: 'Working...' },
      { type: 'quota_exceeded', message: 'Gemini API quota exhausted' },
    ]);
    const events = provider.parseStream(1, tmpDir, '');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, 'must have error event');
    assert.strictEqual(err.content.code, 'error_quota');
    assert.strictEqual(events[events.length - 1].type, 'done');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('parseStream: stderr quota -> type:error with code:error_quota (not type:error_quota)', () => {
  const tmpDir = makeTmpDir();
  try {
    const events = provider.parseStream(1, tmpDir, 'quota exceeded for this billing period');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, 'must have type:error event for stderr quota');
    assert.strictEqual(err.content.code, 'error_quota');
    assert.ok(!events.some(e => e.type === 'error_quota'), 'must NOT emit type:error_quota');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('parseStream: all events have ts field (number)', () => {
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

// ── _detectAuthSurface ────────────────────────────────────────────────────────

const detectAuthSurface = provider._detectAuthSurface;

test('_detectAuthSurface: GEMINI_API_KEY set -> ai-studio', () => {
  const saved = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'test-key-123';
    delete process.env.GOOGLE_CLOUD_PROJECT;
    assert.strictEqual(detectAuthSurface(), 'ai-studio');
  } finally {
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('_detectAuthSurface: GOOGLE_CLOUD_PROJECT set, no API key -> vertex-redirect', () => {
  const savedKey = process.env.GEMINI_API_KEY;
  const savedProj = process.env.GOOGLE_CLOUD_PROJECT;
  try {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_CLOUD_PROJECT = 'my-gcp-project';
    assert.strictEqual(detectAuthSurface(), 'vertex-redirect');
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    else delete process.env.GEMINI_API_KEY;
    if (savedProj !== undefined) process.env.GOOGLE_CLOUD_PROJECT = savedProj;
    else delete process.env.GOOGLE_CLOUD_PROJECT;
  }
});

test('_detectAuthSurface: neither env set -> code-assist', () => {
  const savedKey = process.env.GEMINI_API_KEY;
  const savedProj = process.env.GOOGLE_CLOUD_PROJECT;
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    assert.strictEqual(detectAuthSurface(), 'code-assist');
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    else delete process.env.GEMINI_API_KEY;
    if (savedProj !== undefined) process.env.GOOGLE_CLOUD_PROJECT = savedProj;
    else delete process.env.GOOGLE_CLOUD_PROJECT;
  }
});

test('loginInstructions: mentions all three auth paths', () => {
  const s = provider.loginInstructions();
  assert.ok(s.includes('GEMINI_API_KEY'), 'must mention GEMINI_API_KEY');
  assert.ok(s.includes('gemini auth'), 'must mention gemini auth');
  assert.ok(s.includes('gemini-vertex'), 'must mention gemini-vertex for Vertex AI path');
});

// ── Summary ────────────────────────────────────────────────────────────────────

if (_failed > 0) {
  console.error(`\n${_failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
