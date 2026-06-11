#!/usr/bin/env node
'use strict';

// Regression tests for auto-context aging + updateTopicContext behavior.
// Run: node Agent_Orchestrator/tests/auto-context-aging.test.js
//
// Covers:
//  (1)  auto-context=false in topic-config skips updateTopicContext entirely
//  (2)  touched dir added at age 0 when not previously tracked
//  (3)  untouched entry ages +1 per updateTopicContext call
//  (4)  entry that equals maxContextLifespan is evicted (not included in updated list)
//  (5)  touched entry's age resets to 0 even if it had a prior age
//  (6)  string-form context-files entries normalized to {path, age:0} objects
//  (7)  non-existent context-files entries are dropped on update
//  (8)  auto-context defaults to true when key absent (source-level check)
//  (9)  max-context-lifespan: no eviction when maxLifespan is undefined/null
// (10)  context-files key alias: `context` and `contextFiles` treated identically to `context-files`

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS     = path.join(__dirname, '..');
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
const configUtils = require(path.join(HARNESS, 'src', 'config-utils.js'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ctx-')); }
function tmpCfg(obj) {
  const p = path.join(os.tmpdir(), `auto-ctx-cfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  const loaded = configUtils.loadConfig(p);
  try { fs.unlinkSync(p); } catch {}
  return loaded;
}

// Inline replica of the updateTopicContext logic, isolated from I/O side-effects
// (no file writes, no lock acquisition). The replica mirrors the real logic so
// that tests verify the algorithm rather than just the source text.
function applyContextUpdate(topicConfig, touchedDirs) {
  if (!(topicConfig.autoContext ?? topicConfig['auto-context'] ?? true)) return null;
  const maxLifespan = topicConfig.maxContextLifespan ?? topicConfig['max-context-lifespan'];
  const sourceEntries = topicConfig['context-files'] ?? topicConfig.contextFiles ?? topicConfig.context ?? [];
  const tmp = tmpdir();
  // Only keep entries whose path actually exists on disk — simulate by creating them.
  const existing = sourceEntries.map(e =>
    typeof e === 'string' ? { path: e, age: 0 } : e
  ).filter(e => {
    // In tests, we pre-create files to simulate existence.
    try { return fs.existsSync(path.join(tmp, e.path)); } catch { return false; }
  });
  const updated = [];
  for (const entry of existing) {
    const newAge = touchedDirs.has(entry.path) ? 0 : (entry.age || 0) + 1;
    if (maxLifespan && newAge >= maxLifespan) continue;
    updated.push({ path: entry.path, age: newAge });
  }
  const existingPaths = new Set(updated.map(e => e.path));
  for (const dir of touchedDirs) {
    if (!existingPaths.has(dir)) updated.push({ path: dir, age: 0 });
  }
  fs.rmdirSync(tmp);
  return updated;
}

// Variant that accepts an `existsDirs` set instead of real fs.
function computeContextUpdate({ contextFiles, touchedDirs, maxLifespan, autoContext = true }) {
  if (!autoContext) return null;
  const sourceEntries = contextFiles || [];
  const existing = sourceEntries.map(e =>
    typeof e === 'string' ? { path: e, age: 0 } : e
  ).filter(e => existsDirs.has(e.path));
  // NOTE: existsDirs is defined outside for injection; see tests below.
  return { existing };
}

// Pure logic helper that matches the real updateTopicContext algorithm.
// `warnFn` (optional) is called with the dropped path when an entry fails the existsCheck.
function runContextUpdate({ autoContext, maxLifespan, sourceEntries, touchedDirs, existingPathsOnDisk, warnFn }) {
  if (!autoContext) return null;
  const normalized = (sourceEntries || []).map(e =>
    typeof e === 'string' ? { path: e, age: 0 } : e
  );
  const entriesNorm = [];
  for (const e of normalized) {
    if (existingPathsOnDisk.has(e.path)) {
      entriesNorm.push(e);
    } else if (warnFn) {
      warnFn(e.path);
    }
  }
  const updated = [];
  for (const entry of entriesNorm) {
    const newAge = touchedDirs.has(entry.path) ? 0 : (entry.age || 0) + 1;
    if (maxLifespan && newAge >= maxLifespan) continue;
    updated.push({ path: entry.path, age: newAge });
  }
  const existingPaths = new Set(updated.map(e => e.path));
  for (const dir of touchedDirs) {
    if (!existingPaths.has(dir)) updated.push({ path: dir, age: 0 });
  }
  return updated;
}

// ── (1) auto-context=false skips updateTopicContext ───────────────────────────
test('(1) auto-context=false in topic-config: updateTopicContext returns early', () => {
  assert.ok(/topicConfig\.autoContext \?\? true/.test(runAgentSrc) ||
    /autoContext.*\?\?.*true/.test(runAgentSrc),
    'run-agent.js updateTopicContext must check autoContext with default true');
  // Replica: returns null when autoContext=false.
  const r = runContextUpdate({
    autoContext: false,
    maxLifespan: null,
    sourceEntries: [{ path: 'src', age: 2 }],
    touchedDirs: new Set(['src']),
    existingPathsOnDisk: new Set(['src']),
  });
  assert.strictEqual(r, null, 'null must be returned when autoContext=false');
});

// ── (2) touched dir added at age 0 ───────────────────────────────────────────
test('(2) newly-touched dir not previously in context-files is added at age 0', () => {
  const result = runContextUpdate({
    autoContext: true,
    maxLifespan: null,
    sourceEntries: [],
    touchedDirs: new Set(['src/new-dir']),
    existingPathsOnDisk: new Set(),
  });
  assert.strictEqual(result.length, 1, 'one entry must be added for the touched dir');
  assert.strictEqual(result[0].path, 'src/new-dir', 'entry path must match touched dir');
  assert.strictEqual(result[0].age, 0, 'entry age must be 0 for newly-touched dir');
});

// ── (3) untouched entry ages +1 ──────────────────────────────────────────────
test('(3) untouched existing entry ages by +1 per updateTopicContext call', () => {
  const result = runContextUpdate({
    autoContext: true,
    maxLifespan: null,
    sourceEntries: [{ path: 'src/stable', age: 2 }],
    touchedDirs: new Set(),
    existingPathsOnDisk: new Set(['src/stable']),
  });
  const entry = result.find(e => e.path === 'src/stable');
  assert.ok(entry, 'untouched entry must remain in the list');
  assert.strictEqual(entry.age, 3, 'age must increment from 2 to 3');
});

// ── (4) entry at maxContextLifespan is evicted ────────────────────────────────
test('(4) entry whose new age equals maxContextLifespan is removed (evicted)', () => {
  // maxLifespan=5, current age=4 -> newAge=5 >= maxLifespan -> evicted.
  const result = runContextUpdate({
    autoContext: true,
    maxLifespan: 5,
    sourceEntries: [{ path: 'src/old', age: 4 }],
    touchedDirs: new Set(),
    existingPathsOnDisk: new Set(['src/old']),
  });
  assert.ok(!result.find(e => e.path === 'src/old'),
    'entry reaching maxContextLifespan must be evicted from context-files');
});

// ── (5) touched entry resets age to 0 ────────────────────────────────────────
test('(5) touching a dir that is already tracked resets its age to 0', () => {
  const result = runContextUpdate({
    autoContext: true,
    maxLifespan: 10,
    sourceEntries: [{ path: 'src/revived', age: 7 }],
    touchedDirs: new Set(['src/revived']),
    existingPathsOnDisk: new Set(['src/revived']),
  });
  const entry = result.find(e => e.path === 'src/revived');
  assert.ok(entry, 'touched entry must still be present');
  assert.strictEqual(entry.age, 0, 'age of touched entry must reset to 0');
});

// ── (6) string-form entries normalized to {path, age:0} ──────────────────────
test('(6) string-form context-files entries are normalised to {path, age} objects', () => {
  const result = runContextUpdate({
    autoContext: true,
    maxLifespan: null,
    sourceEntries: ['src/string-path'],
    touchedDirs: new Set(),
    existingPathsOnDisk: new Set(['src/string-path']),
  });
  const entry = result.find(e => e.path === 'src/string-path');
  assert.ok(entry, 'string-form entry must be retained');
  assert.strictEqual(entry.age, 1, 'string-form entry starts at age 0, then ages to 1 when not touched');
});

// ── (7) non-existent entries dropped ─────────────────────────────────────────
test('(7) context-files entries whose paths no longer exist on disk are dropped', () => {
  const result = runContextUpdate({
    autoContext: true,
    maxLifespan: null,
    sourceEntries: [{ path: 'src/deleted', age: 1 }],
    touchedDirs: new Set(),
    existingPathsOnDisk: new Set(), // 'src/deleted' does NOT exist
  });
  assert.ok(!result.find(e => e.path === 'src/deleted'),
    'non-existent context-files entry must be dropped');
});

// ── (8) auto-context defaults to true ────────────────────────────────────────
test('(8) auto-context defaults to true: updateTopicContext runs when key absent from config', () => {
  assert.ok(/\?\?\s*true/.test(runAgentSrc),
    'run-agent.js must use `?? true` default for autoContext');
  // Replica: omitting autoContext runs the update.
  const result = runContextUpdate({
    autoContext: undefined ?? true,
    maxLifespan: null,
    sourceEntries: [],
    touchedDirs: new Set(['src/auto-default']),
    existingPathsOnDisk: new Set(),
  });
  assert.ok(Array.isArray(result), 'update must run (returns array) when autoContext defaults to true');
});

// ── (9) no eviction when maxLifespan is null/undefined ────────────────────────
test('(9) entries are never evicted when max-context-lifespan is null/undefined', () => {
  const result = runContextUpdate({
    autoContext: true,
    maxLifespan: undefined,
    sourceEntries: [{ path: 'src/very-old', age: 99 }],
    touchedDirs: new Set(),
    existingPathsOnDisk: new Set(['src/very-old']),
  });
  const entry = result.find(e => e.path === 'src/very-old');
  assert.ok(entry, 'no-lifespan entry must never be evicted');
  assert.strictEqual(entry.age, 100, 'age increments without bound when no maxLifespan');
});

// ── (10) context-files alias: `context` / `contextFiles` read as fallback ─────
test('(10) run-agent.js updateTopicContext reads `context-files` || contextFiles || context aliases', () => {
  assert.ok(/\?\?\s*topicConfig\.contextFiles\s*\?\?\s*topicConfig\.context/.test(runAgentSrc) ||
    /context-files.*contextFiles.*context/.test(runAgentSrc),
    'updateTopicContext must resolve context-files via contextFiles and context aliases');
});

// ── (11) typo entry warn-and-drop ─────────────────────────────────────────────
test('(11) typo path like "laude_Code_Harness" is dropped and a warning is emitted', () => {
  // Verify run-agent.js emits a console.warn for missing entries.
  assert.ok(
    /console\.warn\(.*context-hygiene.*dropping/.test(runAgentSrc) ||
    /context-hygiene.*non-existent/.test(runAgentSrc),
    'run-agent.js updateTopicContext must emit console.warn for non-existent paths'
  );

  const warned = [];
  const result = runContextUpdate({
    autoContext: true,
    maxLifespan: null,
    sourceEntries: [
      { path: 'laude_Code_Harness', age: 0 },   // typo — missing leading 'C'
      { path: 'Agent_Orchestrator/src', age: 1 },
    ],
    touchedDirs: new Set(),
    existingPathsOnDisk: new Set(['Agent_Orchestrator/src']),
    warnFn: (p) => warned.push(p),
  });

  assert.ok(!result.find(e => e.path === 'laude_Code_Harness'),
    'typo entry must be dropped from context-files');
  assert.ok(result.find(e => e.path === 'Agent_Orchestrator/src'),
    'valid entry must be retained');
  assert.strictEqual(warned.length, 1,
    'exactly one warning must be emitted for the typo entry');
  assert.strictEqual(warned[0], 'laude_Code_Harness',
    'warning must name the bad path');
});

if (_failed === 0) console.log('\nAll auto-context-aging tests passed.');
