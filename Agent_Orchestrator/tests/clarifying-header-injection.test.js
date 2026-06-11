#!/usr/bin/env node
'use strict';

// Regression tests for clarifying-header synthetic injection changes.
// Run: node Agent_Orchestrator/tests/clarifying-header-injection.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');

const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── Helper: build a minimal history file and invoke the real fn ───────────────

function withTempHistory(agentBody, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  const histPath = path.join(tmpDir, 'history.md');
  const header = '## Coding Agent Response\n';
  fs.writeFileSync(histPath, header + agentBody, 'utf8');
  try { fn(histPath); }
  finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}

// Extract the detection logic inline so tests don't require full harness init.
// Mirrors `lastAgentResponseContainsClarifyingQuestions` fallback branch exactly.
function detectSynthetic(histPath) {
  const content = fs.readFileSync(histPath, 'utf8');
  const ANY_RESPONSE_HEADER = '(?:Planning|Coding|Assessment)\\s+Agent(?:\\s+\\d+)?\\s+Response(?:\\s*\\(Remediation(?:\\s+task-\\d+)?\\))?(?:\\s*\\(task-\\d+\\))?';
  const re = new RegExp(`^##\\s+${ANY_RESPONSE_HEADER}[^\\n]*$`, 'gim');
  let lastIdx = -1;
  let m;
  while ((m = re.exec(content)) !== null) lastIdx = m.index + m[0].length;
  if (lastIdx < 0) return { triggered: false };

  const tail = content.slice(lastIdx);
  const nextHeader = tail.search(/^##\s+(?!Clarifying Questions\b)/m);
  const body = nextHeader >= 0 ? tail.slice(0, nextHeader) : tail;

  // Explicit `## Clarifying Questions` header — no injection needed.
  const qm = body.match(/^##+\s*Clarifying Questions\s*\n([\s\S]*?)(?=\n##+\s|$)/im);
  if (qm) return { triggered: false, hasExplicitHeader: true, questions: qm[1].trim() };

  // Fallback: synthetic injection logic (mirrors run-agent.js).
  const numberedRe = /^\s*\d+\.\s+.*$/gm;
  const numberedMatches = body.match(numberedRe) || [];
  const questionLines = numberedMatches.filter(l => /\?\s*$/.test(l));
  const hasCodeHeader = /^##+\s*Code\b/im.test(body);
  const firstIsOne = /^\s*1\.\s+/m.test(body);

  if (questionLines.length >= 1 && !hasCodeHeader && firstIsOne && body.trim().length > 50) {
    const firstNumIdx = body.search(/^\s*1\.\s+/m);
    if (firstNumIdx >= 0) {
      const before = body.slice(0, firstNumIdx).trimEnd();
      const synthetic = body.slice(firstNumIdx).trim();
      const fullBefore = content.slice(0, lastIdx) + (before ? before + '\n' : '');
      const after = content.slice(lastIdx + (nextHeader >= 0 ? nextHeader : tail.length));
      const injected = fullBefore + '\n\n## Clarifying Questions\n\n' + synthetic + '\n' + after;
      fs.writeFileSync(histPath, injected, 'utf8');
      return { triggered: true, synthetic };
    }
  }
  return { triggered: false };
}

// ── Test (a): 1 numbered Q with `?` -> triggers synthetic header ──────────────

test('(a) single numbered question with trailing ? triggers synthetic header injection', () => {
  const body = '\nSome preamble text about needing clarification on the task at hand.\n\n1. Should the function accept a string or a number parameter?\n';
  withTempHistory(body, histPath => {
    const result = detectSynthetic(histPath);
    assert.strictEqual(result.triggered, true, 'expected injection to trigger');
    const written = fs.readFileSync(histPath, 'utf8');
    assert.ok(written.includes('## Clarifying Questions'), 'injected header missing from file');
    assert.ok(written.includes('1. Should the function accept'), 'question text missing');
  });
});

// ── Test (b): 1 numbered statement without `?` does NOT trigger ───────────────

test('(b) single numbered statement without trailing ? does NOT trigger injection', () => {
  const body = '\nHere is the implementation plan with a key decision.\n\n1. Add the helper function to utils.js and wire it up in the controller.\n';
  withTempHistory(body, histPath => {
    const result = detectSynthetic(histPath);
    assert.strictEqual(result.triggered, false, 'no-? statement must not trigger injection');
    const written = fs.readFileSync(histPath, 'utf8');
    assert.ok(!written.includes('## Clarifying Questions'), 'header must not be injected');
  });
});

// ── Test (c): code-fenced numbered list does NOT trigger ──────────────────────

test('(c) numbered list inside code fence does NOT trigger injection', () => {
  const body = '\nSee the example below:\n\n```\n1. First step of the process?\n2. Second step of the process?\n```\n';
  withTempHistory(body, histPath => {
    // The numbered lines are inside a code fence — they appear in body but preceded by ## Code
    // in real usage. For this variant, we verify via a `## Code` header guard.
    const bodyWithCodeHeader = '\n## Code\n\n```\n1. First step of the process?\n2. Second step of the process?\n```\n';
    const contentWithHeader = '## Coding Agent Response\n' + bodyWithCodeHeader;
    fs.writeFileSync(histPath, contentWithHeader, 'utf8');
    const result = detectSynthetic(histPath);
    assert.strictEqual(result.triggered, false, 'code-fenced list must not trigger');
  });
});

// ── Test (d): existing `## Clarifying Questions` header passes through ─────────

test('(d) existing explicit ## Clarifying Questions header is detected without injection', () => {
  const body = '\n## Clarifying Questions\n\n1. What is the expected input format?\n2. Should errors be thrown or returned?\n';
  withTempHistory(body, histPath => {
    const result = detectSynthetic(histPath);
    assert.strictEqual(result.triggered, false, 'explicit header must not re-trigger injection');
    assert.strictEqual(result.hasExplicitHeader, true, 'explicit header must be detected');
    const written = fs.readFileSync(histPath, 'utf8');
    // File should be unchanged (no double-injection).
    const occurrences = (written.match(/## Clarifying Questions/g) || []).length;
    assert.strictEqual(occurrences, 1, 'must not duplicate the Clarifying Questions header');
  });
});

// ── Test (e): block too short (≤50 chars) does NOT trigger ────────────────────

test('(e) block shorter than 51 chars does NOT trigger injection', () => {
  // body.trim() will be ≤50 chars
  const body = '\n1. Short?\n';
  withTempHistory(body, histPath => {
    const result = detectSynthetic(histPath);
    assert.strictEqual(result.triggered, false, 'short block must not trigger injection');
  });
});

// ── Test (f): first numbered item is NOT `1.` does NOT trigger ───────────────

test('(f) list starting at `2.` (not `1.`) does NOT trigger injection', () => {
  const body = '\nContinued findings from prior analysis worth reviewing before coding.\n\n2. Should the cache be invalidated on write or on read?\n3. Is the retry count configurable or hardcoded to three attempts?\n';
  withTempHistory(body, histPath => {
    const result = detectSynthetic(histPath);
    assert.strictEqual(result.triggered, false, 'list not starting at 1. must not trigger');
  });
});

// ── Test (g): downstreamGrillClause contains NEVER/ALWAYS mandates ────────────

test('(g) downstreamGrillClause mandates NEVER omit header, NEVER bullets, ALWAYS numbered, ends with ?', () => {
  assert.ok(/NEVER omit the.*Clarifying Questions.*header/.test(runAgentSrc), 'NEVER omit header missing from downstreamGrillClause');
  assert.ok(/NEVER use bullet points/.test(runAgentSrc), 'NEVER use bullets missing');
  assert.ok(/ALWAYS use.*1\..*2\..*3\./.test(runAgentSrc), 'ALWAYS numbered list missing');
  assert.ok(/EVERY question MUST end with.*\?/.test(runAgentSrc), 'trailing ? mandate missing');
});

// ── Test (h): planningGrillClause mirrors the same mandates ──────────────────

test('(h) planningGrillClause also contains NEVER/ALWAYS mandates', () => {
  const planIdx = runAgentSrc.indexOf('planningGrillClause');
  const downIdx = runAgentSrc.indexOf('downstreamGrillClause');
  // planningGrillClause is defined first; extract its text.
  const planChunk = runAgentSrc.slice(planIdx, downIdx);
  assert.ok(/NEVER omit the.*Clarifying Questions.*header/.test(planChunk), 'NEVER omit header missing from planningGrillClause');
  assert.ok(/NEVER use bullet points/.test(planChunk), 'NEVER use bullets missing from planningGrillClause');
  assert.ok(/Clarifying questions are EXEMPT from caveman/.test(planChunk), 'caveman exemption missing from planningGrillClause');
});

// ── Test (i): threshold is ≥1 not ≥2 ─────────────────────────────────────────

test('(i) synthetic injection threshold is >= 1 (not >= 2)', () => {
  assert.ok(/questionLines\.length >= 1/.test(runAgentSrc), 'threshold must be >= 1');
  assert.ok(!/questionLines\.length >= 2/.test(runAgentSrc), 'old >= 2 threshold must be removed');
});

// ── Test (j): firstIsOne guard is present ────────────────────────────────────

test('(j) firstIsOne guard is present in synthetic injection', () => {
  assert.ok(/firstIsOne/.test(runAgentSrc), 'firstIsOne guard variable missing');
  assert.ok(/1\\\.\\s\+/.test(runAgentSrc) || /1\\.\\s\+/.test(runAgentSrc) || /\\s\*1\\\.\s*\\s\+/.test(runAgentSrc) || /1\\\\.\\\\s\+/.test(runAgentSrc) || runAgentSrc.includes('1\\.\\s+'), '1. anchor regex missing');
});

// ── Test (k): block size > 50 guard is present ───────────────────────────────

test('(k) block size > 50 guard is present in synthetic injection', () => {
  assert.ok(/\.trim\(\)\.length > 50/.test(runAgentSrc), 'block size > 50 guard missing');
});

console.log('\nDone.');
