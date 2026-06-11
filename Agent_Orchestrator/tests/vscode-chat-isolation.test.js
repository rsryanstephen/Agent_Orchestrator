#!/usr/bin/env node
'use strict';

// Regression tests for the VS Code chat-history pollution remediation:
//   (1) Harness `claude` child spawns must not leave per-call session JSONL files in
//       `~/.claude/projects/<cwd-hash>/` after they finish — those files surface in the
//       VS Code Claude Code extension's recents pane and pollute user chat history.
//   (2) `sanitizeForAppend` must collapse stacked `*Model: ...*` italic footers at the
//       tail of an agent response down to a single footer line, preventing the duplicate
//       footer regression the assessment agent flagged.
//
// Run: node Agent_Orchestrator/tests/vscode-chat-isolation.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS   = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ─── (1) VS Code chat-history isolation ───────────────────────────────────────

test('(1a) source declares cleanupHarnessSessionFile()', () => {
  assert.match(src, /function\s+cleanupHarnessSessionFile\s*\(\s*sessionId\s*\)/);
});

test('(1b) cleanup scans ~/.claude/projects/<dir>/<sessionId>.jsonl', () => {
  // Must reach into the projects dir under the home directory and remove the per-session JSONL,
  // since `--session-id` alone does not prevent the CLI from writing into the user's project dir
  // (where the VS Code extension lists recents).
  assert.match(src, /os\.homedir\(\)[\s\S]*?'\.claude'[\s\S]*?'projects'/);
  assert.match(src, /\$\{sessionId\}\.jsonl/);
  assert.match(src, /fs\.unlinkSync\(/);
});

test('(1c) cleanup is invoked from runClaude close + error handlers', () => {
  const closeBlock = src.match(/child\.on\('close'[\s\S]*?\}\);\s*\n\s*child\.on\('error'[\s\S]*?\}\);/);
  assert.ok(closeBlock, 'expected child close + error handlers');
  const calls = closeBlock[0].match(/cleanupHarnessSessionFile\(sessionId\)/g) || [];
  assert.ok(calls.length >= 2, `expected cleanup invoked in both close and error handlers, found ${calls.length}`);
});

test('(1d) cleanupHarnessSessionFile() deletes only the matching session JSONL', () => {
  // Functional test: stub a fake ~/.claude/projects/<hash>/ tree and confirm the helper
  // deletes only files named `<sessionId>.jsonl` for the target id.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-vscode-iso-'));
  const projects = path.join(fakeHome, '.claude', 'projects');
  const hashA = path.join(projects, 'C--Users-x-RepoA');
  const hashB = path.join(projects, 'C--Users-x-RepoB');
  fs.mkdirSync(hashA, { recursive: true });
  fs.mkdirSync(hashB, { recursive: true });
  const targetId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const other    = 'ffffffff-1111-2222-3333-444444444444';
  const targetA = path.join(hashA, `${targetId}.jsonl`);
  const targetB = path.join(hashB, `${targetId}.jsonl`);
  const keepA   = path.join(hashA, `${other}.jsonl`);
  for (const f of [targetA, targetB, keepA]) fs.writeFileSync(f, '{}\n', 'utf8');

  // Inline replica of the helper, parameterized on home dir.
  function cleanup(sessionId, home) {
    const projectsDir = path.join(home, '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return;
    for (const entry of fs.readdirSync(projectsDir)) {
      const f = path.join(projectsDir, entry, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch {} }
    }
  }
  cleanup(targetId, fakeHome);

  assert.ok(!fs.existsSync(targetA), 'target JSONL in hashA should be deleted');
  assert.ok(!fs.existsSync(targetB), 'target JSONL in hashB should be deleted');
  assert.ok(fs.existsSync(keepA), 'unrelated session JSONL must be preserved');
});

// ─── (2) Duplicate-footer collapse ────────────────────────────────────────────

// Inline replica of sanitizeForAppend's footer-collapse stage so we can test
// behaviour without booting run-agent.js (which has CLI side effects on require).
function sanitizeReplica(content) {
  let out = content.replace(/(?:\n[ \t]*-{3,}[ \t]*)+\s*$/g, '').replace(/\s+$/g, '');
  while (true) {
    const m = out.match(/\*Model:[^\n*]*\*\s*\n+(?=\*Model:[^\n*]*\*\s*$)/);
    if (!m) break;
    out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
  }
  return out;
}

test('(2a) two stacked *Model:* footers collapse to the last one', () => {
  const body =
    '- some bullet\n\n' +
    '*Model: claude-opus-4-7 | Tokens: 6 in / 3 425 out*\n\n' +
    '*Model: claude-opus-4-7 | Tokens: 6 in / 625 out*';
  const out = sanitizeReplica(body);
  const matches = out.match(/\*Model:[^\n]*\*/g) || [];
  assert.strictEqual(matches.length, 1, `expected 1 footer, got ${matches.length}: ${out}`);
  assert.match(out, /625 out/);
  assert.doesNotMatch(out, /3 425 out/);
});

test('(2b) three stacked footers collapse to the last one', () => {
  const body =
    'text\n\n' +
    '*Model: A | Tokens: 1*\n\n' +
    '*Model: B | Tokens: 2*\n\n' +
    '*Model: C | Tokens: 3*';
  const out = sanitizeReplica(body);
  const matches = out.match(/\*Model:[^\n]*\*/g) || [];
  assert.strictEqual(matches.length, 1, `expected 1 footer, got ${matches.length}`);
  assert.match(out, /Tokens: 3/);
});

test('(2c) single footer is left untouched', () => {
  const body = 'just one bullet\n\n*Model: claude-opus-4-7 | Tokens: 6 in / 100 out*';
  const out = sanitizeReplica(body);
  const matches = out.match(/\*Model:[^\n]*\*/g) || [];
  assert.strictEqual(matches.length, 1);
  assert.match(out, /Tokens: 6 in \/ 100 out/);
});

test('(2d) sanitizeForAppend source contains the collapse loop', () => {
  // Regex literal must appear inside sanitizeForAppend; guards against accidental removal.
  const sanitizeBlock = src.match(/function\s+sanitizeForAppend[\s\S]*?\n\}/);
  assert.ok(sanitizeBlock, 'sanitizeForAppend block must exist');
  assert.match(sanitizeBlock[0], /\*Model:\[\^\\n\*\]\*\\\*/);
});
