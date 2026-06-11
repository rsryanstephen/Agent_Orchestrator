#!/usr/bin/env node
'use strict';

// Unit tests for the recordTouchedFiles porcelain parser in run-agent.js.
// Exercises: BOM stripping, CRLF handling, rename (R) status, copy (C) status,
// quoted paths, and the existsSync guard that prevents phantom dirs from landing
// in touchedDirs / context-files.
//
// Run: node Agent_Orchestrator/tests/record-touched-files.test.js

const fs   = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS     = path.join(__dirname, '..');
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Pure replica of the recordTouchedFiles parser logic (no git, no fs.existsSync).
// `existingDirs` simulates which candidate dirs pass the existsSync check.
function parsePortcelain(stdout, existingDirs = new Set()) {
  const touchedDirs = new Set();
  // Do not trim() the whole string: leading space on first line IS the X status code.
  const clean = stdout.replace(/^﻿/, '');
  for (const raw of clean.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^(..)\s(.+)$/);
    if (!m) continue;
    const xy = m[1];
    let filePath = m[2].trim().replace(/\\/g, '/');
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    if ((xy.includes('R') || xy.includes('C')) && filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop().trim();
      if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    }
    const dir = path.posix.dirname(filePath);
    const candidate = dir && dir !== '.' ? dir : filePath;
    if (!existingDirs.has(candidate)) continue;
    touchedDirs.add(candidate);
  }
  return touchedDirs;
}

// ── Source-level guards ───────────────────────────────────────────────────────

test('src: BOM strip uses replace(/^\\uFEFF/)', () => {
  assert.ok(
    /replace\(\/\^\\uFEFF\//.test(runAgentSrc) ||
    /replace\(\/\^﻿\//.test(runAgentSrc) ||
    /replace\(\/\^﻿\//.test(runAgentSrc),
    'run-agent.js recordTouchedFiles must strip leading BOM'
  );
});

test('src: CRLF strip uses replace(/\\r$/)', () => {
  assert.ok(
    /replace\(\/\\r\$\//.test(runAgentSrc),
    'run-agent.js must strip trailing CR from each line'
  );
});

test('src: regex parse uses /^(..)\\s(.+)$/', () => {
  assert.ok(
    /match\(\/\^\(\.{2}\)\\s\(\./.test(runAgentSrc) ||
    /match\(\/\^\(\.\.\)\\s/.test(runAgentSrc),
    'run-agent.js must use regex line parsing in recordTouchedFiles'
  );
});

test('src: copy status C handled alongside rename R', () => {
  assert.ok(
    /xy\.includes\('C'\)/.test(runAgentSrc),
    "run-agent.js must handle 'C' copy status in recordTouchedFiles"
  );
});

test('src: existsSync guard added in recordTouchedFiles before touchedDirs.add', () => {
  // Verify the guard appears in the function body (between recordTouchedFiles and updateTopicContext).
  const fnMatch = runAgentSrc.match(/function recordTouchedFiles\(\)[\s\S]*?function updateTopicContext/);
  assert.ok(fnMatch, 'could not locate recordTouchedFiles function body');
  assert.ok(
    /existsSync/.test(fnMatch[0]),
    'recordTouchedFiles must call fs.existsSync before touchedDirs.add'
  );
});

test('src: existsSync guard added in updateTopicContext touchedDirs loop', () => {
  const fnMatch = runAgentSrc.match(/function updateTopicContext\(\)[\s\S]*?function /);
  assert.ok(fnMatch, 'could not locate updateTopicContext function body');
  assert.ok(
    /existsSync/.test(fnMatch[0]),
    'updateTopicContext must call fs.existsSync when adding new touchedDirs entries'
  );
});

// ── Parser behaviour tests ────────────────────────────────────────────────────

const REAL = new Set(['Agent_Orchestrator/src', 'Agent_Orchestrator/src/lib']);

test('plain modified line: path parsed intact', () => {
  const out = ' M Agent_Orchestrator/src/run-agent.js\n';
  const dirs = parsePortcelain(out, REAL);
  assert.ok(dirs.has('Agent_Orchestrator/src'), 'dir must be Agent_Orchestrator/src, not laude_Code_Harness/src');
  assert.ok(!dirs.has('laude_Code_Harness/src'), 'must NOT contain truncated path');
});

test('BOM on first line: path parsed intact', () => {
  const bom = '﻿';
  const out = `${bom} M Agent_Orchestrator/src/run-agent.js\n`;
  const dirs = parsePortcelain(out, REAL);
  assert.ok(dirs.has('Agent_Orchestrator/src'), 'BOM must not corrupt path parsing');
  assert.ok(!dirs.has('laude_Code_Harness/src'), 'must NOT contain truncated path after BOM strip');
});

test('CRLF line endings: path parsed intact', () => {
  const out = ' M Agent_Orchestrator/src/run-agent.js\r\nA  Agent_Orchestrator/src/lib/foo.js\r\n';
  const dirs = parsePortcelain(out, REAL);
  assert.ok(dirs.has('Agent_Orchestrator/src'), 'CRLF must not corrupt first-line path');
  assert.ok(dirs.has('Agent_Orchestrator/src/lib'), 'CRLF must not corrupt second-line path');
});

test('BOM + CRLF combined: paths parsed intact', () => {
  const bom = '﻿';
  const out = `${bom}M  Agent_Orchestrator/src/run-agent.js\r\n M  Agent_Orchestrator/src/lib/foo.js\r\n`;
  const dirs = parsePortcelain(out, REAL);
  assert.ok(dirs.has('Agent_Orchestrator/src'), 'BOM+CRLF: first line path intact');
  assert.ok(dirs.has('Agent_Orchestrator/src/lib'), 'BOM+CRLF: second line path intact');
});

test('rename (R) status: dest path used, not source', () => {
  const out = 'R  old/path/file.js -> Agent_Orchestrator/src/run-agent.js\n';
  const dirs = parsePortcelain(out, REAL);
  assert.ok(dirs.has('Agent_Orchestrator/src'), 'rename dest dir must be used');
  assert.ok(!dirs.has('old/path'), 'rename source dir must be ignored');
});

test('copy (C) status: dest path used, not source', () => {
  const out = 'C  Agent_Orchestrator/src/run-agent.js -> Agent_Orchestrator/src/lib/copy.js\n';
  const real = new Set(['Agent_Orchestrator/src', 'Agent_Orchestrator/src/lib']);
  const dirs = parsePortcelain(out, real);
  assert.ok(dirs.has('Agent_Orchestrator/src/lib'), 'copy dest dir must be used');
  assert.ok(!dirs.has('Agent_Orchestrator/src'), 'copy source dir excluded when not independently touched');
});

test('quoted path: quotes stripped, path intact', () => {
  const out = ' M "Agent_Orchestrator/src/run-agent.js"\n';
  const dirs = parsePortcelain(out, REAL);
  assert.ok(dirs.has('Agent_Orchestrator/src'), 'quoted path must parse correctly');
});

test('non-existent dir: excluded from touchedDirs', () => {
  const out = ' M phantom/path/file.js\n M Agent_Orchestrator/src/real.js\n';
  const dirs = parsePortcelain(out, REAL);
  assert.ok(!dirs.has('phantom/path'), 'non-existent dir must not reach touchedDirs');
  assert.ok(dirs.has('Agent_Orchestrator/src'), 'real dir must still be included');
});

test('root-level file: filePath used as candidate (dirname is .)', () => {
  const out = ' M toplevel.txt\n';
  const dirs = parsePortcelain(out, new Set(['toplevel.txt']));
  assert.ok(dirs.has('toplevel.txt'), 'root-level file must use filePath as candidate');
});

if (_failed === 0) console.log('\nAll record-touched-files tests passed.');
