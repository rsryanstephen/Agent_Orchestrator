#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test: validates that the gemini provider's parseStream
 * correctly processes canned JSONL log files.
 * Skipped entirely when probe() returns false (gemini CLI not installed).
 *
 * (GS1) assistant_text synthesised from `{"type":"message","text":"hello"}`
 * (GS2) tool_call event from `{"type":"tool_call","name":"Read","input":{}}`
 * (GS3) usage event with input_tokens + output_tokens
 * (GS4) done event present as last event
 * (GS5) error_quota event emitted when exitCode != 0 and stderr contains "quota"
 * (GS6) error_quota from JSONL quota_exceeded entry -> type:error, code:error_quota
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const geminiPath = path.join(HARNESS, 'src', 'lib', 'providers', 'gemini.js');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

if (!fs.existsSync(geminiPath)) {
  console.warn('[skip] gemini.js not found — gemini-smoke tests skipped.');
  process.exit(0);
}

const gemini = require(geminiPath);

if (!gemini.probe()) {
  console.warn('[skip] gemini CLI not available (probe() returned false) — gemini-smoke tests skipped.');
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-smoke-'));

function writeLogDir(entries) {
  const logFile = path.join(tmpDir, 'session.jsonl');
  fs.writeFileSync(logFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return tmpDir;
}

test('(GS1) assistant_text synthesised from type=message entry', () => {
  const logDir = writeLogDir([
    { type: 'message', text: 'hello world' },
  ]);
  const events = gemini.parseStream(0, logDir, '');
  const texts = events.filter(e => e.type === 'assistant_text');
  assert.ok(texts.length > 0, 'Expected at least one assistant_text event');
  assert.ok(texts.some(e => (e.content && e.content.text || '').includes('hello world')), 'assistant_text content must include "hello world"');
});

test('(GS1b) assistant_text synthesised from type=assistant entry', () => {
  const logDir = writeLogDir([
    { type: 'assistant', content: 'hello assistant' },
  ]);
  const events = gemini.parseStream(0, logDir, '');
  const texts = events.filter(e => e.type === 'assistant_text');
  assert.ok(texts.length > 0, 'Expected at least one assistant_text event');
  assert.ok(texts.some(e => (e.content && e.content.text || '').includes('hello assistant')));
});

test('(GS2) tool_call event from type=tool_call entry', () => {
  const logDir = writeLogDir([
    { type: 'tool_call', id: 'tc1', name: 'Read', input: { file_path: '/foo.ts' } },
  ]);
  const events = gemini.parseStream(0, logDir, '');
  const toolCalls = events.filter(e => e.type === 'tool_call');
  assert.ok(toolCalls.length > 0, 'Expected at least one tool_call event');
  assert.ok(toolCalls.some(e => (e.content && e.content.name) === 'Read'), 'tool_call must have name=Read');
});

test('(GS3) usage event with token counts', () => {
  const logDir = writeLogDir([
    { type: 'usage', input_tokens: 100, output_tokens: 50 },
  ]);
  const events = gemini.parseStream(0, logDir, '');
  const usage = events.find(e => e.type === 'usage');
  assert.ok(usage, 'Expected a usage event');
  assert.strictEqual(usage.content.input_tokens, 100);
  assert.strictEqual(usage.content.output_tokens, 50);
});

test('(GS4) done event present as last event on success', () => {
  const logDir = writeLogDir([
    { type: 'message', text: 'ok' },
  ]);
  const events = gemini.parseStream(0, logDir, '');
  const last = events[events.length - 1];
  assert.ok(last && last.type === 'done', 'Last event must be "done"');
});

test('(GS5) error_quota event when exitCode!=0 and stderr contains "quota"', () => {
  const logDir = writeLogDir([]);
  const events = gemini.parseStream(1, logDir, 'Error: quota exceeded for this billing period');
  const err = events.find(e => e.type === 'error');
  assert.ok(err, 'Expected an error event when stderr mentions quota');
  assert.strictEqual(err.content.code, 'error_quota');
});

test('(GS6) quota_exceeded JSONL entry -> type:error with code:error_quota', () => {
  const logDir = writeLogDir([
    { type: 'quota_exceeded', message: 'Gemini API quota exhausted' },
  ]);
  const events = gemini.parseStream(1, logDir, '');
  const err = events.find(e => e.type === 'error');
  assert.ok(err, 'Expected error event for quota_exceeded entry');
  assert.strictEqual(err.content.code, 'error_quota');
  assert.ok(!events.some(e => e.type === 'error_quota'), 'must NOT emit type:error_quota directly');
});

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (_failed === 0) console.log('\nAll gemini-smoke tests passed.');
else console.error(`\n${_failed} gemini-smoke test(s) FAILED.`);
