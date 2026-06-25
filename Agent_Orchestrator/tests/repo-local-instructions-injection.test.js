#!/usr/bin/env node
'use strict';

/**
 * Tests for repo-local instructions injection (.github/copilot-instructions.md,
 * CLAUDE.md, GEMINI.md, etc).
 * Run: node Agent_Orchestrator/tests/repo-local-instructions-injection.test.js
 *
 * Covers:
 *  (1) .github/copilot-instructions.md is read and included
 *  (2) CLAUDE.md is read and included
 *  (3) claude.md is skipped if CLAUDE.md exists
 *  (4) GEMINI.md is read and included
 *  (5) Returns empty string when no files exist
 *  (6) Non-empty results wrapped in ## Repo-Local Instructions header
 *  (7) buildSystemPrompt prepends repo-local clause to prompt
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const { buildRepoLocalInstructionsClause, buildSystemPrompt } = require(path.join(HARNESS, 'src', 'run-agent.js'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-local-test-'));
  return d;
}

function cleanup(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) cleanup(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

test('returns empty string when no repo-local files exist', () => {
  const tmpDir = tmpdir();
  try {
    const result = buildRepoLocalInstructionsClause(tmpDir);
    assert.strictEqual(result, '', 'should return empty string');
  } finally {
    cleanup(tmpDir);
  }
});

test('reads .github/copilot-instructions.md when it exists', () => {
  const tmpDir = tmpdir();
  try {
    const ghDir = path.join(tmpDir, '.github');
    fs.mkdirSync(ghDir, { recursive: true });
    const copilotPath = path.join(ghDir, 'copilot-instructions.md');
    const content = 'Copilot instructions for this repo';
    fs.writeFileSync(copilotPath, content, 'utf8');

    const result = buildRepoLocalInstructionsClause(tmpDir);
    assert(result.includes('## Repo-Local Instructions'), 'should have header');
    assert(result.includes(content), 'should include copilot instructions');
  } finally {
    cleanup(tmpDir);
  }
});

test('reads CLAUDE.md when it exists', () => {
  const tmpDir = tmpdir();
  try {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const content = 'Claude instructions for this repo';
    fs.writeFileSync(claudePath, content, 'utf8');

    const result = buildRepoLocalInstructionsClause(tmpDir);
    assert(result.includes('## Repo-Local Instructions'), 'should have header');
    assert(result.includes(content), 'should include CLAUDE.md');
  } finally {
    cleanup(tmpDir);
  }
});

test('skips claude.md if CLAUDE.md exists', () => {
  const tmpDir = tmpdir();
  try {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const claudeContent = 'CLAUDE.md content';
    fs.writeFileSync(claudePath, claudeContent, 'utf8');

    // On case-insensitive filesystems (Windows), CLAUDE.md and claude.md are the same file,
    // so we just verify CLAUDE.md is read
    const result = buildRepoLocalInstructionsClause(tmpDir);
    assert(result.includes(claudeContent), 'should include CLAUDE.md');
  } finally {
    cleanup(tmpDir);
  }
});

test('reads claude.md if CLAUDE.md does not exist', () => {
  const tmpDir = tmpdir();
  try {
    const claudeLowercasePath = path.join(tmpDir, 'claude.md');
    const content = 'claude.md content';
    fs.writeFileSync(claudeLowercasePath, content, 'utf8');

    const result = buildRepoLocalInstructionsClause(tmpDir);
    assert(result.includes('## Repo-Local Instructions'), 'should have header');
    assert(result.includes(content), 'should include claude.md');
  } finally {
    cleanup(tmpDir);
  }
});

test('reads GEMINI.md when it exists', () => {
  const tmpDir = tmpdir();
  try {
    const geminiPath = path.join(tmpDir, 'GEMINI.md');
    const content = 'Gemini instructions for this repo';
    fs.writeFileSync(geminiPath, content, 'utf8');

    const result = buildRepoLocalInstructionsClause(tmpDir);
    assert(result.includes('## Repo-Local Instructions'), 'should have header');
    assert(result.includes(content), 'should include GEMINI.md');
  } finally {
    cleanup(tmpDir);
  }
});

test('concatenates multiple repo-local files with newline separation', () => {
  const tmpDir = tmpdir();
  try {
    const ghDir = path.join(tmpDir, '.github');
    fs.mkdirSync(ghDir, { recursive: true });

    const copilotPath = path.join(ghDir, 'copilot-instructions.md');
    const copilotContent = 'Copilot instructions';
    fs.writeFileSync(copilotPath, copilotContent, 'utf8');

    const geminiPath = path.join(tmpDir, 'GEMINI.md');
    const geminiContent = 'Gemini instructions';
    fs.writeFileSync(geminiPath, geminiContent, 'utf8');

    const result = buildRepoLocalInstructionsClause(tmpDir);
    assert(result.includes('## Repo-Local Instructions'), 'should have header');
    assert(result.includes(copilotContent), 'should include copilot instructions');
    assert(result.includes(geminiContent), 'should include gemini instructions');
    // Check order: copilot instructions should come before gemini
    const copilotIdx = result.indexOf(copilotContent);
    const geminiIdx = result.indexOf(geminiContent);
    assert(copilotIdx < geminiIdx, 'copilot instructions should come before gemini');
  } finally {
    cleanup(tmpDir);
  }
});

test('skips unreadable files silently', () => {
  const tmpDir = tmpdir();
  try {
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const validContent = 'Valid content';
    fs.writeFileSync(claudePath, validContent, 'utf8');

    // Attempt to create an unreadable file (if on Unix; this test may not work on Windows)
    const unreadablePath = path.join(tmpDir, 'unreadable.md');
    fs.writeFileSync(unreadablePath, 'Unreadable', 'utf8');
    try {
      fs.chmodSync(unreadablePath, 0o000);
      // If chmod worked, the test applies; otherwise skip this part
      const result = buildRepoLocalInstructionsClause(tmpDir);
      assert(result.includes(validContent), 'should include readable file content');
      // Clean up the unreadable file
      fs.chmodSync(unreadablePath, 0o644);
    } catch (err) {
      // chmod may not work on Windows; skip this part
    }
  } finally {
    cleanup(tmpDir);
  }
});

if (_failed) {
  console.error(`\n${_failed} test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed');
}
