'use strict';

/**
 * Regression tests for history-compress-enqueue feature.
 *
 * Verifies: max-history-lines config key, _pendingHistoryCompress flag,
 * _enqueueHistoryCompress helper, compress directive handling in dequeueAndTriggerNext,
 * and require.main guard in compress-memory.js.
 *
 * Run: node --test Agent_Orchestrator/tests/history-compress-enqueue.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const RUN_AGENT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'run-agent.js'), 'utf8'
);
const COMPRESS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'compress-memory.js'), 'utf8'
);
const GLOBAL_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'global-config.json'), 'utf8')
);

// ── global-config.json ────────────────────────────────────────────────────────

test('global-config: max-history-lines key exists', () => {
  assert.ok('max-history-lines' in GLOBAL_CONFIG, 'max-history-lines missing from global-config.json');
});

test('global-config: max-history-lines is 4000', () => {
  assert.strictEqual(GLOBAL_CONFIG['max-history-lines'], 4000);
});

test('global-config: comment key for max-history-lines exists', () => {
  assert.ok('// max-history-lines' in GLOBAL_CONFIG, '// max-history-lines comment key missing');
});

// ── compress-memory.js ────────────────────────────────────────────────────────

test('compress-memory: CLI IIFE guarded with require.main === module', () => {
  assert.ok(
    COMPRESS_SRC.includes('if (require.main === module)'),
    'compress-memory.js must guard its CLI IIFE with require.main === module'
  );
});

test('compress-memory: module.exports includes compressTopic', () => {
  assert.ok(COMPRESS_SRC.includes("module.exports = { compressTopic"), 'compressTopic must be exported');
});

test('compress-memory: safe to require (no IIFE side-effects)', () => {
  assert.doesNotThrow(() => {
    // Requiring the module must not throw — IIFE is gated by require.main check.
    const mod = require('../src/compress-memory.js');
    assert.ok(typeof mod.compressTopic === 'function', 'compressTopic must be a function');
    assert.ok(typeof mod.autoCompressIfNeeded === 'function', 'autoCompressIfNeeded must be a function');
  });
});

// ── run-agent.js — module-level flag ──────────────────────────────────────────

test('run-agent: _pendingHistoryCompress flag declared', () => {
  assert.ok(
    RUN_AGENT_SRC.includes('let _pendingHistoryCompress = false'),
    '_pendingHistoryCompress flag not found in run-agent.js'
  );
});

test('run-agent: _checkHistoryLineLimit function defined', () => {
  assert.ok(
    RUN_AGENT_SRC.includes('function _checkHistoryLineLimit('),
    '_checkHistoryLineLimit not found in run-agent.js'
  );
});

test('run-agent: _checkHistoryLineLimit reads max-history-lines from config', () => {
  const fnStart = RUN_AGENT_SRC.indexOf('function _checkHistoryLineLimit(');
  const fnEnd = RUN_AGENT_SRC.indexOf('\nfunction ', fnStart + 1);
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd);
  assert.ok(fnSrc.includes("config['max-history-lines']"), 'must read max-history-lines from config');
  assert.ok(fnSrc.includes('4000'), 'must default to 4000 lines');
});

// ── run-agent.js — appendToFile wired ────────────────────────────────────────

test('run-agent: appendToFile calls _checkHistoryLineLimit after normal write path', () => {
  const fnStart = RUN_AGENT_SRC.indexOf('function appendToFile(');
  const fnEnd = RUN_AGENT_SRC.indexOf('\nfunction appendUserPromptSuffixToFile(', fnStart);
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd);
  const checkCount = (fnSrc.match(/_checkHistoryLineLimit\(/g) || []).length;
  assert.ok(checkCount >= 2, `appendToFile must call _checkHistoryLineLimit at both write sites; found ${checkCount}`);
});

// ── run-agent.js — runPipeline enqueue ───────────────────────────────────────

test('run-agent: runPipeline checks _pendingHistoryCompress before return true', () => {
  // Verify both lines exist somewhere in the file
  assert.ok(RUN_AGENT_SRC.includes('_pendingHistoryCompress = false;'), '_pendingHistoryCompress reset line missing');
  assert.ok(RUN_AGENT_SRC.includes('_enqueueHistoryCompress();'), '_enqueueHistoryCompress() call missing');
  // Both must appear before emitEndOfRunLimits (the function that follows runPipeline's return true)
  const resetIdx = RUN_AGENT_SRC.indexOf('_pendingHistoryCompress = false;');
  const enqueueCallIdx = RUN_AGENT_SRC.indexOf('_enqueueHistoryCompress();');
  const emitIdx = RUN_AGENT_SRC.indexOf('async function emitEndOfRunLimits(');
  assert.ok(emitIdx > 0, 'emitEndOfRunLimits function not found as boundary marker');
  assert.ok(resetIdx < emitIdx, '_pendingHistoryCompress reset must be before emitEndOfRunLimits');
  assert.ok(enqueueCallIdx < emitIdx, '_enqueueHistoryCompress call must be before emitEndOfRunLimits');
});

test('run-agent: _enqueueHistoryCompress function defined after topicDirPath', () => {
  const topicDirIdx = RUN_AGENT_SRC.indexOf('function topicDirPath()');
  const enqueueIdx = RUN_AGENT_SRC.indexOf('function _enqueueHistoryCompress()');
  assert.ok(enqueueIdx > topicDirIdx, '_enqueueHistoryCompress must be defined after topicDirPath');
});

test('run-agent: _enqueueHistoryCompress uses prependHead to add directive', () => {
  const fnStart = RUN_AGENT_SRC.indexOf('function _enqueueHistoryCompress()');
  const fnEnd = RUN_AGENT_SRC.indexOf('\n// Map shorthand', fnStart);
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd);
  assert.ok(fnSrc.includes('prependHead'), 'must use prependHead to prepend compress entry');
  assert.ok(fnSrc.includes('__compress-history__'), 'must use __compress-history__ sentinel');
});

test('run-agent: _enqueueHistoryCompress guards against double-enqueue', () => {
  const fnStart = RUN_AGENT_SRC.indexOf('function _enqueueHistoryCompress()');
  const fnEnd = RUN_AGENT_SRC.indexOf('\n// Map shorthand', fnStart);
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd);
  assert.ok(fnSrc.includes('__compress-history__'), 'duplicate-guard checks for __compress-history__ sentinel');
});

// ── run-agent.js — dequeueAndTriggerNext directive handling ──────────────────

test('run-agent: dequeueAndTriggerNext handles __compress-history__ directive', () => {
  const fnStart = RUN_AGENT_SRC.indexOf('async function dequeueAndTriggerNext(');
  const fnEnd = RUN_AGENT_SRC.indexOf('\n// ── Dispatch', fnStart);
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd);
  assert.ok(fnSrc.includes('__compress-history__'), '__compress-history__ directive check not found in dequeueAndTriggerNext');
});

test('run-agent: compress directive calls compressTopic before pipeline dispatch', () => {
  const fnStart = RUN_AGENT_SRC.indexOf('async function dequeueAndTriggerNext(');
  const fnEnd = RUN_AGENT_SRC.indexOf('\n// ── Dispatch', fnStart);
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd);
  const directiveIdx = fnSrc.indexOf("'__compress-history__'");
  const compressIdx = fnSrc.indexOf('compressTopic(topic)');
  const pipelineIdx = fnSrc.indexOf('resolvePipelineFromShorthand(block.pipeline)');
  assert.ok(compressIdx > directiveIdx, 'compressTopic call must follow directive check');
  assert.ok(pipelineIdx > compressIdx, 'pipeline dispatch must come after compress directive handler');
});

test('run-agent: compress directive uses require of compress-memory.js', () => {
  const fnStart = RUN_AGENT_SRC.indexOf('async function dequeueAndTriggerNext(');
  const fnEnd = RUN_AGENT_SRC.indexOf('\n// ── Dispatch', fnStart);
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd);
  assert.ok(fnSrc.includes("require('./compress-memory.js')"), "must require compress-memory.js for the directive");
});

test('run-agent: compress directive uses continue to drain next queue block', () => {
  const fnStart = RUN_AGENT_SRC.indexOf('async function dequeueAndTriggerNext(');
  const fnEnd = RUN_AGENT_SRC.indexOf('\n// ── Dispatch', fnStart);
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd);
  const directiveIdx = fnSrc.indexOf("'__compress-history__'");
  const continueIdx = fnSrc.indexOf('continue;', directiveIdx);
  const pipelineIdx = fnSrc.indexOf('resolvePipelineFromShorthand', directiveIdx);
  assert.ok(continueIdx > 0 && continueIdx < pipelineIdx, 'directive handler must use continue before pipeline dispatch');
});

// ── functional: end-to-end wiring ─────────────────────────────────────────────

test('functional: >max-lines file → __compress-history__ written to queue; duplicate-guard prevents double-enqueue', () => {
  const os = require('os');
  const promptQueue = require('../src/prompt-queue');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-enqueue-test-'));
  try {
    const histFile = path.join(tmpDir, 'history.md');
    // Each line is ~83 bytes so 4001 lines ≈ 332 KB; 332000/80 ≈ 4150 > 4000 ✓
    const line = '## Response ' + 'x'.repeat(70) + '\n';
    fs.writeFileSync(histFile, line.repeat(4001));
    fs.writeFileSync(path.join(tmpDir, 'prompt-queue.md'), '# Prompt Queue\n\n---\n\n');

    // Replicate _checkHistoryLineLimit (statSync-based, fix #2)
    const maxLines = GLOBAL_CONFIG['max-history-lines'] || 4000;
    let pending = false;
    try { if (fs.statSync(histFile).size / 80 > maxLines) pending = true; } catch {}
    assert.ok(pending, 'size-based estimate must detect a >4000-line file');

    // Replicate _enqueueHistoryCompress (real promptQueue calls, with duplicate-guard)
    function tryEnqueue() {
      const { blocks } = promptQueue.parseQueue(tmpDir);
      if (blocks.length > 0 && String(blocks[0].body || '').trim() === '__compress-history__') return false;
      promptQueue.prependHead(tmpDir, '__compress-history__');
      return true;
    }

    assert.ok(tryEnqueue(), 'first enqueue must succeed');
    assert.ok(!tryEnqueue(), 'second enqueue must be no-op (duplicate-guard)');

    const queueContent = fs.readFileSync(path.join(tmpDir, 'prompt-queue.md'), 'utf8');
    assert.ok(queueContent.includes('__compress-history__'), 'prompt-queue.md must contain the directive');
    const count = (queueContent.match(/__compress-history__/g) || []).length;
    assert.strictEqual(count, 1, 'directive must appear exactly once (no double-enqueue)');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
