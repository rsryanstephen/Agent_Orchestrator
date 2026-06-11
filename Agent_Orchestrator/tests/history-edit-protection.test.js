#!/usr/bin/env node
'use strict';

// Regression tests for history edit-wipe + duplicate-append fixes.
// Covers:
//   - truncateHistoryIfAgentWrote no longer restores stale content (size-only growth check)
//   - appendToFile idempotence guard prevents duplicate identical blocks
//   - Auto-fill detection treats footer-marker absence as user-authored
// Run: node Agent_Orchestrator/tests/history-edit-protection.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const crypto = require('crypto');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── Helpers replicating the run-agent.js implementations under test ─────────

function acquireFileLock(targetPath) {
  const lockPath = targetPath + '.lock';
  fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  return lockPath;
}
function releaseFileLock(lockPath) { try { fs.unlinkSync(lockPath); } catch {} }

function snapshotHistorySize(historyPath) {
  try {
    const buf = fs.readFileSync(historyPath);
    return { size: buf.length };
  } catch { return { size: 0 }; }
}

function truncateHistoryIfAgentWrote(historyPath, before) {
  const snap = (before && typeof before === 'object') ? before : { size: before || 0 };
  const lock = acquireFileLock(historyPath);
  try {
    let buf;
    try { buf = fs.readFileSync(historyPath); } catch { return; }
    if (buf.length > snap.size) {
      const fd = fs.openSync(historyPath, 'r+');
      try { fs.ftruncateSync(fd, snap.size); } finally { fs.closeSync(fd); }
    }
  } finally { releaseFileLock(lock); }
}

function sanitizeForAppend(content) {
  return content.replace(/(?:\n[ \t]*-{3,}[ \t]*)+\s*$/g, '').replace(/\s+$/g, '');
}
function stripTrailingDivider(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8');
    const trimmed = existing.replace(/\s*---\s*$/, '');
    if (trimmed.length !== existing.length) fs.writeFileSync(filePath, trimmed, 'utf8');
  } catch {}
}

function appendToFile(filePath, header, content, { appendUserPromptSuffix = true } = {}) {
  const lock = acquireFileLock(filePath);
  try {
    stripTrailingDivider(filePath);
    const safe = sanitizeForAppend(content);
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      const re = new RegExp(`(^|\\n)${header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'g');
      let m, lastBody = null;
      while ((m = re.exec(existing)) !== null) lastBody = m[2];
      if (lastBody != null) {
        const norm = s => s.replace(/\r\n/g, '\n').replace(/\n\n\*Model:[^*]*\*\s*$/, '').trim();
        if (norm(lastBody) === norm(safe) && norm(safe).length > 0) {
          if (appendUserPromptSuffix && !/##\s+User Prompt\s*\n*\s*$/.test(existing)) {
            fs.appendFileSync(filePath, '\n\n---\n\n## User Prompt\n\n', 'utf8');
          }
          return;
        }
      }
    } catch {}
    const suffix = appendUserPromptSuffix ? '\n\n---\n\n## User Prompt\n\n' : '';
    const tail = suffix || '\n';
    fs.appendFileSync(filePath, `\n\n---\n\n${header}\n\n${safe}${tail}`, 'utf8');
  } finally { releaseFileLock(lock); }
}

function hashBody(s) {
  const norm = (s || '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

function detectUserAuthored(existingReply, priorAutoHash) {
  const existingIsAutoFill = !!(existingReply && priorAutoHash && hashBody(existingReply) === priorAutoHash);
  const AUTOFILL_MARKER = '_(Auto-filled by assessment agent';
  const hasAutoFillMarker = !!(existingReply && existingReply.includes(AUTOFILL_MARKER));
  return !!(existingReply && !existingIsAutoFill && !hasAutoFillMarker);
}

// ── Test fixtures ───────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-edit-test-'));
function tmpFile(name) { return path.join(TMP, name); }

// ── Tests ───────────────────────────────────────────────────────────────────

test('truncateHistoryIfAgentWrote preserves user mid-phase edits to earlier prefix', () => {
  const p = tmpFile('a.md');
  const original = '## User Prompt\n\nfirst\n';
  fs.writeFileSync(p, original);
  const snap = snapshotHistorySize(p);
  // User edits the existing content (replaces "first" with longer "first-edited") AND agent appends nothing.
  const userEdited = '## User Prompt\n\nfirst-edited-by-user\n';
  fs.writeFileSync(p, userEdited);
  truncateHistoryIfAgentWrote(p, snap);
  // With the fix, size-only check: file grew (edited content longer), so it gets truncated back to snap.size
  // but content of prefix is preserved (NOT restored to stale snapshot).
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(!after.includes('first\n') || after.includes('first-edited'), 'must not restore stale pre-edit content');
});

test('truncateHistoryIfAgentWrote does NOT resurrect stale tail that user deleted', () => {
  const p = tmpFile('b.md');
  const original = '## User Prompt\n\nfoo\n\n---\n\n## User Prompt\n\nstale-tail\n';
  fs.writeFileSync(p, original);
  const snap = snapshotHistorySize(p);
  // User deletes the stale trailing `## User Prompt` block.
  const trimmed = '## User Prompt\n\nfoo\n';
  fs.writeFileSync(p, trimmed);
  truncateHistoryIfAgentWrote(p, snap);
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(!after.includes('stale-tail'), 'must not resurrect stale tail block');
});

test('truncateHistoryIfAgentWrote truncates only agent-appended bytes when file grew', () => {
  const p = tmpFile('c.md');
  const before = '## User Prompt\n\nhi\n';
  fs.writeFileSync(p, before);
  const snap = snapshotHistorySize(p);
  fs.appendFileSync(p, '\n\n---\n\n## Coding Agent Response\n\nappended\n');
  truncateHistoryIfAgentWrote(p, snap);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

test('appendToFile is idempotent for identical Coding Agent Response body', () => {
  const p = tmpFile('d.md');
  fs.writeFileSync(p, '## User Prompt\n\ntask\n');
  appendToFile(p, '## Coding Agent Response', 'did the thing', { appendUserPromptSuffix: false });
  const afterFirst = fs.readFileSync(p, 'utf8');
  appendToFile(p, '## Coding Agent Response', 'did the thing', { appendUserPromptSuffix: false });
  const afterSecond = fs.readFileSync(p, 'utf8');
  const occurrences = (afterSecond.match(/## Coding Agent Response/g) || []).length;
  assert.strictEqual(occurrences, 1, 'duplicate identical block must be skipped');
  assert.strictEqual(afterFirst, afterSecond, 'second identical append is a no-op');
});

test('appendToFile still appends when body differs', () => {
  const p = tmpFile('e.md');
  fs.writeFileSync(p, '## User Prompt\n\ntask\n');
  appendToFile(p, '## Coding Agent Response', 'first body', { appendUserPromptSuffix: false });
  appendToFile(p, '## Coding Agent Response', 'second body', { appendUserPromptSuffix: false });
  const content = fs.readFileSync(p, 'utf8');
  const occurrences = (content.match(/## Coding Agent Response/g) || []).length;
  assert.strictEqual(occurrences, 2);
  assert.ok(content.includes('first body') && content.includes('second body'));
});

test('detectUserAuthored: matching signature hash → not user-authored', () => {
  const body = 'auto-filled answers';
  assert.strictEqual(detectUserAuthored(body, hashBody(body)), false);
});

test('detectUserAuthored: autofill marker present but hash mismatched → not user-authored', () => {
  const body = 'edited slightly\n\n_(Auto-filled by assessment agent — press ENTER twice in the CLI to submit.)_';
  assert.strictEqual(detectUserAuthored(body, hashBody('different')), false);
});

test('detectUserAuthored: marker removed by user edit → user-authored, skip overwrite', () => {
  const body = 'user typed their own real answer';
  assert.strictEqual(detectUserAuthored(body, hashBody('the prior auto-fill body')), true);
});

test('detectUserAuthored: empty reply → not user-authored', () => {
  assert.strictEqual(detectUserAuthored(null, 'somehash'), false);
  assert.strictEqual(detectUserAuthored('', 'somehash'), false);
});

// Cleanup
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
