#!/usr/bin/env node
'use strict';

// Unit tests for the recordTouchedFiles porcelain parser in run-agent.js.
// Exercises: BOM stripping, CRLF handling, rename (R) status, copy (C) status,
// quoted paths, and the guards that prevent phantom dirs or harness-owned paths
// from landing in touchedDirs / context-files.
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

// Requirement quote: "The Harness has just addressed the first prompt in the new topic "hackathon". I see a problem where the first context files it adds to the topic config are not context files within the root repo but are rather context files within the Agent_Orchestrator harness root itself."
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

// Requirement quote: "The Harness has just addressed the first prompt in the new topic "hackathon". I see a problem where the first context files it adds to the topic config are not context files within the root repo but are rather context files within the Agent_Orchestrator harness root itself."
test('src: recordTouchedFiles runs git status in repoRoot and validates candidates under repoRoot', () => {
  const fnMatch = runAgentSrc.match(/function recordTouchedFiles\(\)[\s\S]*?function updateTopicContext/);
  assert.ok(fnMatch, 'could not locate recordTouchedFiles function body');
  assert.ok(/cwd:\s*repoRoot/.test(fnMatch[0]),
    'recordTouchedFiles must run git status with cwd: repoRoot');
  assert.ok(/path\.join\(repoRoot,\s*candidate\)/.test(fnMatch[0]),
    'recordTouchedFiles must validate touched candidates relative to repoRoot');
});

test('src: recordTouchedFiles skips harness-owned candidates', () => {
  const fnMatch = runAgentSrc.match(/function recordTouchedFiles\(\)[\s\S]*?function updateTopicContext/);
  assert.ok(fnMatch, 'could not locate recordTouchedFiles function body');
  assert.ok(/isHarnessOwnedContextPath\(candidate,\s*repoRoot\)/.test(fnMatch[0]),
    'recordTouchedFiles must skip harness-owned candidates before tracking touchedDirs');
});

// Requirement quote: "The Harness has just addressed the first prompt in the new topic "hackathon". I see a problem where the first context files it adds to the topic config are not context files within the root repo but are rather context files within the Agent_Orchestrator harness root itself."
test('src: existsSync guard added in updateTopicContext touchedDirs loop', () => {
  const fnMatch = runAgentSrc.match(/function updateTopicContext\(\)[\s\S]*?function /);
  assert.ok(fnMatch, 'could not locate updateTopicContext function body');
  assert.ok(
    /existsSync/.test(fnMatch[0]),
    'updateTopicContext must call fs.existsSync when adding new touchedDirs entries'
  );
});

// Requirement quote: "The Harness has just addressed the first prompt in the new topic "hackathon". I see a problem where the first context files it adds to the topic config are not context files within the root repo but are rather context files within the Agent_Orchestrator harness root itself."
test('src: updateTopicContext resolves existing and new context-files under repoRoot', () => {
  const fnMatch = runAgentSrc.match(/function updateTopicContext\(\)[\s\S]*?function /);
  assert.ok(fnMatch, 'could not locate updateTopicContext function body');
  assert.ok(/path\.join\(repoRoot,\s*e\.path\)/.test(fnMatch[0]),
    'updateTopicContext must resolve existing context entries relative to repoRoot');
  assert.ok(/path\.join\(repoRoot,\s*dir\)/.test(fnMatch[0]),
    'updateTopicContext must resolve new touched dirs relative to repoRoot');
});

test('src: updateTopicContext drops harness-owned entries before persisting', () => {
  const fnMatch = runAgentSrc.match(/function updateTopicContext\(\)[\s\S]*?function /);
  assert.ok(fnMatch, 'could not locate updateTopicContext function body');
  assert.ok(/dropping harness-owned context-files entry/.test(fnMatch[0]),
    'updateTopicContext must warn when dropping harness-owned context-files entries');
  assert.ok(/isHarnessOwnedContextPath\(dir,\s*repoRoot\)/.test(fnMatch[0]),
    'updateTopicContext must skip harness-owned touched dirs before appending them');
});

// ── isHarnessOwnedContextPath tests ──────────────────────────────────────────

// Pure replica of isHarnessOwnedContextPath with ROOT and HARNESS injected.
// Allows unit testing without coupling to run-agent.js module state.
function testIsHarnessOwnedContextPath(relPath, baseRoot, ROOT_val, HARNESS_val) {
  if (typeof relPath !== 'string' || !relPath.trim()) return false;
  const normalize = s => s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\/+/, '');
  const harnessRel = normalize(path.relative(baseRoot, HARNESS_val));

  // Primary branch: if harness is relative to baseRoot (not external), use relative check
  if (harnessRel && harnessRel !== '.' && !harnessRel.startsWith('../') && !path.isAbsolute(harnessRel)) {
    const candidate = normalize(relPath);
    if (candidate === harnessRel || candidate.startsWith(harnessRel + '/')) {
      return true;
    }
  }

  // Fallback branch: resolve relPath against ROOT and check against absolute HARNESS.
  const absFromRoot = path.resolve(ROOT_val, relPath);
  const normHarness = path.normalize(HARNESS_val);
  if (absFromRoot === normHarness || absFromRoot.startsWith(normHarness + path.sep)) {
    return true;
  }

  return false;
}

test('src: isHarnessOwnedContextPath contains ROOT-anchored fallback', () => {
  assert.ok(
    /path\.resolve\(ROOT/.test(runAgentSrc),
    'isHarnessOwnedContextPath must contain path.resolve(ROOT fallback for git-output paths'
  );
});

test('isHarnessOwnedContextPath(\'Agent_Orchestrator\', externalRoot) returns true via fallback', () => {
  const externalRoot = path.join(__dirname, '..', '..', 'some-external-repo');
  const root = path.join(__dirname, '..', '..');
  const harness = path.join(__dirname, '..');
  const result = testIsHarnessOwnedContextPath('Agent_Orchestrator', externalRoot, root, harness);
  assert.strictEqual(result, true, 'fallback must detect harness when baseRoot is external');
});

test('isHarnessOwnedContextPath(\'Agent_Orchestrator/src\', externalRoot) returns true', () => {
  const externalRoot = path.join(__dirname, '..', '..', 'some-external-repo');
  const root = path.join(__dirname, '..', '..');
  const harness = path.join(__dirname, '..');
  const result = testIsHarnessOwnedContextPath('Agent_Orchestrator/src', externalRoot, root, harness);
  assert.strictEqual(result, true, 'fallback must detect harness subdir when baseRoot is external');
});

test('isHarnessOwnedContextPath(\'src\', externalRoot) returns false (legitimate repo dir)', () => {
  const externalRoot = path.join(__dirname, '..', '..', 'some-external-repo');
  const root = path.join(__dirname, '..', '..');
  const harness = path.join(__dirname, '..');
  const result = testIsHarnessOwnedContextPath('src', externalRoot, root, harness);
  assert.strictEqual(result, false, 'fallback must not match unrelated dirs outside harness');
});

test('isHarnessOwnedContextPath(\'Agent_Orchestrator\', ROOT) returns true (primary path)', () => {
  const root = path.join(__dirname, '..', '..');
  const harness = path.join(__dirname, '..');
  const result = testIsHarnessOwnedContextPath('Agent_Orchestrator', root, root, harness);
  assert.strictEqual(result, true, 'primary path must still work when baseRoot is ROOT');
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
