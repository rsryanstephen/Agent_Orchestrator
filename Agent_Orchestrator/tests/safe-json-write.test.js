#!/usr/bin/env node
'use strict';

/**
 * Tests for safe-json-write.js (atomic write + .bak rotation) and
 * the loadTopicConfig .bak fallback path in config-utils.js.
 *
 * Run: node Agent_Orchestrator/tests/safe-json-write.test.js
 *
 * Coverage:
 *  (SJW1) Happy path: writes valid JSON and file matches expected content
 *  (SJW2) Round-trip: written file parses back to same object
 *  (SJW3) Invalid JSON object that can't serialize -> throws
 *  (SJW4) Pre-serialized invalid JSON string -> throws before writing
 *  (SJW5) schemaCheck violation -> throws, leaves original intact
 *  (SJW6) .bak created on second write (rotation)
 *  (SJW7) .tmp cleaned up on schema-check failure
 *  (LTC1) loadTopicConfig .bak fallback: corrupt primary, valid .bak -> returns .bak content + logs
 *  (LTC2) loadTopicConfig .bak fallback: corrupt primary, corrupt .bak -> logs .bak error, throws original
 *  (LTC3) loadTopicConfig .bak fallback: no .bak -> throws original error
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const { safeJsonWrite } = require(path.join(HARNESS, 'src', 'lib', 'safe-json-write'));
const configUtils = require(path.join(HARNESS, 'src', 'config-utils'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

function tmp(suffix = '.json') {
  return path.join(os.tmpdir(), `sjw-test-${process.pid}-${Date.now()}${suffix}`);
}

// ── safeJsonWrite tests ───────────────────────────────────────────────────────

test('(SJW1) happy path: file written with correct content', () => {
  const p = tmp();
  try {
    safeJsonWrite(p, { a: 1, b: 'hello' });
    assert.ok(fs.existsSync(p), 'target file must exist');
    const content = fs.readFileSync(p, 'utf8');
    assert.ok(content.includes('"a"'), 'content must include key a');
    assert.ok(content.includes('"b"'), 'content must include key b');
  } finally {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + '.bak'); } catch {}
  }
});

test('(SJW2) round-trip: written JSON parses back to same object', () => {
  const p = tmp();
  const obj = { x: 42, nested: { arr: [1, 2, 3] } };
  try {
    safeJsonWrite(p, obj);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(parsed, obj);
  } finally {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + '.bak'); } catch {}
  }
});

test('(SJW4) pre-serialized invalid JSON string -> throws before writing', () => {
  const p = tmp();
  const before = fs.existsSync(p);
  assert.throws(
    () => safeJsonWrite(p, '{bad json:'),
    /JSON validation failed/
  );
  assert.strictEqual(fs.existsSync(p), before, '.tmp must not leave target behind');
  try { fs.unlinkSync(p + '.tmp'); } catch {}
});

test('(SJW5) schemaCheck violation -> throws, original file intact', () => {
  const p = tmp();
  const original = '{"ok":true}\n';
  fs.writeFileSync(p, original, 'utf8');
  try {
    assert.throws(
      () => safeJsonWrite(p, { bad: true }, (obj) => { if (obj.bad) throw new Error('bad key not allowed'); }),
      /bad key not allowed/
    );
    assert.strictEqual(fs.readFileSync(p, 'utf8'), original, 'original must be intact after schemaCheck failure');
  } finally {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + '.bak'); } catch {}
    try { fs.unlinkSync(p + '.tmp'); } catch {}
  }
});

test('(SJW6) .bak created on second write (rotation)', () => {
  const p = tmp();
  try {
    safeJsonWrite(p, { v: 1 });
    safeJsonWrite(p, { v: 2 });
    assert.ok(fs.existsSync(p + '.bak'), '.bak must exist after second write');
    const bak = JSON.parse(fs.readFileSync(p + '.bak', 'utf8'));
    assert.strictEqual(bak.v, 1, '.bak must contain first write content');
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(cur.v, 2, 'current file must contain second write content');
  } finally {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + '.bak'); } catch {}
  }
});

test('(SJW7) .tmp cleaned up on schema-check failure', () => {
  const p = tmp();
  assert.throws(() => safeJsonWrite(p, { v: 1 }, () => { throw new Error('schema reject'); }), /schema reject/);
  assert.ok(!fs.existsSync(p + '.tmp'), '.tmp must be removed after schemaCheck throws');
  try { fs.unlinkSync(p); } catch {}
});

// ── loadTopicConfig .bak fallback tests ──────────────────────────────────────

function makeFakeTopicDir(dir, primaryContent, bakContent) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'topic-config.json'), primaryContent, 'utf8');
  if (bakContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'topic-config.json.bak'), bakContent, 'utf8');
  }
}

test('(LTC1) loadTopicConfig .bak fallback: corrupt primary, valid .bak -> returns .bak content + logs error', () => {
  const dir = path.join(os.tmpdir(), `ltc-test-${process.pid}-1`);
  const fakeRoot = os.tmpdir();
  const fakeGlobal = { topicFilesDir: '.' };
  const topicName = path.basename(dir);
  const validBak = JSON.stringify({ fallback: true });

  makeFakeTopicDir(dir, '{corrupt json', validBak);

  const errLogs = [];
  const origErr = console.error;
  console.error = (...a) => errLogs.push(a.join(' '));
  try {
    const cfg = configUtils.loadTopicConfig(fakeRoot, fakeGlobal, topicName);
    assert.ok(cfg !== null, 'must return config from .bak');
    assert.strictEqual(cfg.fallback, true, 'config must come from .bak');
    assert.ok(errLogs.some(l => l.includes('.bak')), 'must log .bak fallback message');
  } finally {
    console.error = origErr;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('(LTC2) loadTopicConfig: corrupt primary + corrupt .bak -> logs .bak error, throws original', () => {
  const dir = path.join(os.tmpdir(), `ltc-test-${process.pid}-2`);
  const fakeRoot = os.tmpdir();
  const fakeGlobal = { topicFilesDir: '.' };
  const topicName = path.basename(dir);

  makeFakeTopicDir(dir, '{corrupt json', '{also corrupt');

  const errLogs = [];
  const origErr = console.error;
  console.error = (...a) => errLogs.push(a.join(' '));
  try {
    assert.throws(
      () => configUtils.loadTopicConfig(fakeRoot, fakeGlobal, topicName),
      /SyntaxError|Unexpected token|Expected property/
    );
    assert.ok(errLogs.some(l => l.includes('.bak') && l.includes('also failed')), 'must log .bak parse failure');
  } finally {
    console.error = origErr;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('(LTC3) loadTopicConfig: corrupt primary, no .bak -> throws original error', () => {
  const dir = path.join(os.tmpdir(), `ltc-test-${process.pid}-3`);
  const fakeRoot = os.tmpdir();
  const fakeGlobal = { topicFilesDir: '.' };
  const topicName = path.basename(dir);

  makeFakeTopicDir(dir, '{corrupt json');

  try {
    assert.throws(
      () => configUtils.loadTopicConfig(fakeRoot, fakeGlobal, topicName),
      /SyntaxError|Unexpected token|Expected property/
    );
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

if (_failed === 0) {
  console.log(`\nAll safe-json-write tests passed.`);
} else {
  console.error(`\n${_failed} test(s) failed.`);
  process.exitCode = 1;
}
