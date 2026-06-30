#!/usr/bin/env node
'use strict';

// Tests for buildContextSection path resolution, dir expansion, and harness-location hint.
// Run: node Agent_Orchestrator/tests/context-section-rendering.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const vm   = require('vm');
const assert = require('assert');

const HARNESS     = path.join(__dirname, '..');
const RUN_AGENT   = path.join(HARNESS, 'src', 'run-agent.js');
const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── Extract buildContextSection for functional tests ─────────────────────────
// Slice the function text between its declaration and the next top-level function.
function makeFn(mockRoot, mockHarness) {
  const startMarker = '\nfunction buildContextSection(';
  const endMarker   = '\nfunction recordTouchedFiles(';
  const start = runAgentSrc.indexOf(startMarker);
  const end   = runAgentSrc.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1 && start < end, 'buildContextSection not found in run-agent.js');
  const fnSrc = runAgentSrc.slice(start + 1, end);
  const sandbox = { fs, path, ROOT: mockRoot, HARNESS: mockHarness };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return vm.runInContext('buildContextSection', sandbox);
}

// ── Source-level checks ───────────────────────────────────────────────────────

test('signature accepts agentCwd + baseRoot parameters', () => {
  assert.ok(/function buildContextSection\(contextEntries,\s*activeHistoryRel\s*=\s*null,\s*agentCwd\s*=\s*null,\s*baseRoot\s*=\s*ROOT\)/.test(runAgentSrc),
    'agentCwd/baseRoot params missing from signature');
});

test('harness-location hint emitted', () => {
  assert.ok(/Harness location:/.test(runAgentSrc), 'harness hint string absent');
  assert.ok(/path\.resolve\(HARNESS\)/.test(runAgentSrc), 'path.resolve(HARNESS) absent');
});

test('useAbsolute logic present', () => {
  assert.ok(/path\.resolve\(agentCwd\).*!==.*path\.resolve\(baseRoot\)/.test(runAgentSrc), 'useAbsolute comparison absent');
});

test('buildContextSection filters harness-owned context entries', () => {
  assert.ok(/isHarnessOwnedContextPath\(p,\s*baseRoot\)/.test(runAgentSrc),
    'buildContextSection must exclude harness-owned context entries');
});

test('directory expansion: mtime sort + 20-file cap present', () => {
  assert.ok(/files\.sort\(.*mtime/.test(runAgentSrc), 'mtime sort absent');
  assert.ok(/files\.length\s*>\s*20/.test(runAgentSrc), '20-file cap absent');
  assert.ok(/\(directory\)/.test(runAgentSrc), '(directory) annotation absent');
});

test('all callers pass repoRoot as agentCwd + baseRoot', () => {
  const lines = runAgentSrc.split('\n');
  const callSites = lines.filter(l => l.includes('buildContextSection(') && !l.includes('function buildContextSection('));
  for (const l of callSites) {
    assert.ok(/repoRoot,\s*repoRoot\)/.test(l), `caller missing repoRoot base: ${l.trim()}`);
  }
  assert.ok(callSites.length >= 9, `expected ≥9 call sites, found ${callSites.length}`);
});

// ── Functional tests ──────────────────────────────────────────────────────────

test('empty entries returns empty string', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    const fn = makeFn(tmpRoot, HARNESS);
    assert.strictEqual(fn([], null, tmpRoot), '');
    assert.strictEqual(fn(null, null, tmpRoot), '');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('non-existent entries are silently dropped', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    const fn = makeFn(tmpRoot, HARNESS);
    const result = fn(['no-such-file.js'], null, tmpRoot);
    assert.strictEqual(result, '');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('file entry: ROOT-relative path when agentCwd === ROOT', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    fs.writeFileSync(path.join(tmpRoot, 'foo.js'), '');
    const fn = makeFn(tmpRoot, HARNESS);
    const result = fn(['foo.js'], null, tmpRoot);
    assert.ok(result.includes('- foo.js'), `expected relative path; got: ${result}`);
    assert.ok(!result.includes(tmpRoot), 'should not include absolute path when cwd === ROOT');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('file entry: absolute path when agentCwd !== ROOT', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    fs.writeFileSync(path.join(tmpRoot, 'foo.js'), '');
    const fn = makeFn(tmpRoot, HARNESS);
    const differentCwd = path.join(tmpRoot, '..');
    const result = fn(['foo.js'], null, differentCwd);
    const expectedAbs = path.join(tmpRoot, 'foo.js').replace(/\\/g, '/');
    assert.ok(result.includes(`- ${expectedAbs}`), `expected absolute path ${expectedAbs}; got: ${result}`);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('directory entry: expands to files sorted by mtime desc', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    const subdir = path.join(tmpRoot, 'src');
    fs.mkdirSync(subdir);
    // Write files with staggered mtimes
    for (const name of ['a.js', 'b.js', 'c.js']) {
      fs.writeFileSync(path.join(subdir, name), name);
    }
    // Touch c.js last so it has newest mtime
    fs.utimesSync(path.join(subdir, 'c.js'), new Date(), new Date(Date.now() + 2000));
    fs.utimesSync(path.join(subdir, 'b.js'), new Date(), new Date(Date.now() + 1000));
    const fn = makeFn(tmpRoot, HARNESS);
    const result = fn(['src'], null, tmpRoot);
    const cIdx = result.indexOf('c.js');
    const bIdx = result.indexOf('b.js');
    const aIdx = result.indexOf('a.js');
    assert.ok(cIdx < bIdx, 'c.js (newest) should appear before b.js');
    assert.ok(bIdx < aIdx, 'b.js should appear before a.js (oldest)');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('directory entry: caps at 20, annotates with (directory) when over cap', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    const subdir = path.join(tmpRoot, 'big');
    fs.mkdirSync(subdir);
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(subdir, `f${String(i).padStart(2, '0')}.js`), '');
    }
    const fn = makeFn(tmpRoot, HARNESS);
    const result = fn(['big'], null, tmpRoot);
    const fileLines = result.split('\n').filter(l => l.startsWith('- ') && l.includes('.js'));
    assert.strictEqual(fileLines.length, 20, `expected 20 file lines, got ${fileLines.length}`);
    assert.ok(result.includes('(directory)'), 'expected (directory) annotation for capped dir');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('directory entry: no (directory) annotation when ≤20 files', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    const subdir = path.join(tmpRoot, 'small');
    fs.mkdirSync(subdir);
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(subdir, `f${i}.js`), '');
    }
    const fn = makeFn(tmpRoot, HARNESS);
    const result = fn(['small'], null, tmpRoot);
    assert.ok(!result.includes('(directory)'), 'unexpected (directory) annotation for small dir');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('activeHistoryRel entry excluded from output', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    fs.writeFileSync(path.join(tmpRoot, 'history.md'), '');
    fs.writeFileSync(path.join(tmpRoot, 'code.js'), '');
    const fn = makeFn(tmpRoot, HARNESS);
    const result = fn(['history.md', 'code.js'], 'history.md', tmpRoot);
    assert.ok(!result.includes('- history.md'), 'activeHistoryRel should be excluded from file list');
    assert.ok(result.includes('code.js'), 'other entries should remain');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('harness-owned context entries are excluded from rendered output', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    const mockHarness = path.join(tmpRoot, 'Agent_Orchestrator');
    fs.mkdirSync(path.join(mockHarness, 'src'), { recursive: true });
    fs.writeFileSync(path.join(mockHarness, 'src', 'run-agent.js'), '');
    fs.writeFileSync(path.join(tmpRoot, 'app.js'), '');
    const fn = makeFn(tmpRoot, mockHarness);
    const result = fn(['Agent_Orchestrator/src', 'app.js'], null, tmpRoot, tmpRoot);
    assert.ok(!result.includes('Agent_Orchestrator/src'),
      'harness-owned context entry must be excluded from rendered output');
    assert.ok(result.includes('- app.js'),
      'non-harness project entry must remain in rendered output');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('harness hint appears before file list', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  try {
    fs.writeFileSync(path.join(tmpRoot, 'x.js'), '');
    const fn = makeFn(tmpRoot, HARNESS);
    const result = fn(['x.js'], null, tmpRoot);
    const hintIdx = result.indexOf('Harness location:');
    const fileIdx = result.indexOf('- x.js');
    assert.ok(hintIdx !== -1, 'harness hint missing');
    assert.ok(hintIdx < fileIdx, 'harness hint must precede file list');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

if (_failed === 0) console.log('\nAll context-section-rendering tests passed.');
else console.error(`\n${_failed} test(s) failed.`);
