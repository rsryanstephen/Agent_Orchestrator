#!/usr/bin/env node
'use strict';

// Regression tests for stacked-trailing-`## User Prompt`-header bug — see
// claude_harness.md ~5200-5213 for the failure shape. Cases:
//   (1) clean trailing empty placeholder → single tagged section, no duplicates
//   (2) PRE-EXISTING stacked duplicates → collapse to one tagged section
//   (3) tagged section + dangling untagged empty placeholder → collapse correctly
//   (4) appendUserPromptSuffixToFile against file already ending with tagged
//       placeholder → does NOT add another placeholder
//   (5) normalizeTrailingPromptStack against the live fixture mirroring
//       claude_harness.md tail → single tagged section preserved

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');
const {
  stripAllTrailingEmptyPlaceholders,
  collapseInternalEmptyPromptHeaders,
  normalizeTrailingPromptStack,
  TRAILING_PLACEHOLDER_PRESENT_RE,
} = require('../src/normalize-history');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── Pure-fn behavioural tests against normalize-history helpers ─────────────

function injectSimulated(text, body) {
  // Mirror of run-agent.js injectQueuedPromptIntoHistory unified branch.
  const { text: stripped, collapsed } = stripAllTrailingEmptyPlaceholders(text);
  const next = stripped.replace(/\s*$/, '') + `\n\n---\n\n## User Prompt (From the Queue)\n\n${body}\n`;
  return { next, collapsed };
}

test('(1) clean trailing empty placeholder → single tagged section, no duplicates', () => {
  const seeded =
    '# claude_harness - chat history\n\n' +
    '## Coding Agent Response\n\nstuff\n\n' +
    '---\n\n## User Prompt\n\n';
  const { next, collapsed } = injectSimulated(seeded, 'fresh body');
  assert.strictEqual(collapsed, 1, 'one trailing empty placeholder should have been collapsed');
  const headerCount = (next.match(/^##\s+User Prompt/gm) || []).length;
  assert.strictEqual(headerCount, 1, `expected exactly one '## User Prompt' header; got ${headerCount}\n${next}`);
  assert.ok(/## User Prompt \(From the Queue\)\n\nfresh body\n$/.test(next),
    `expected file to end with tagged section + body; got:\n${next}`);
});

test('(2) PRE-EXISTING stacked duplicates → collapse both, single tagged section', () => {
  const seeded =
    '# claude_harness - chat history\n\n' +
    '## Coding Agent Response\n\nstuff\n\n' +
    '---\n\n## User Prompt\n\n' +
    '---\n\n## User Prompt\n\n';
  const { next, collapsed } = injectSimulated(seeded, 'queued body');
  assert.strictEqual(collapsed, 2, `expected 2 placeholders collapsed; got ${collapsed}`);
  const headerCount = (next.match(/^##\s+User Prompt/gm) || []).length;
  assert.strictEqual(headerCount, 1, `expected exactly one '## User Prompt' header after collapse; got ${headerCount}\n${next}`);
  assert.ok(/## User Prompt \(From the Queue\)\n\nqueued body\n$/.test(next));
});

test('(3) tagged section followed by dangling empty placeholder → collapse correctly', () => {
  // 2nd-iteration dequeueAndTriggerNext scenario: previous phase already
  // injected a tagged section, then appendUserPromptSuffix added another empty
  // placeholder below it.
  const seeded =
    '# x\n\n## Coding Agent Response\n\nprior\n\n' +
    '---\n\n## User Prompt (From the Queue)\n\nprior body\n\n' +
    '---\n\n## User Prompt\n\n';
  const { next, collapsed } = injectSimulated(seeded, 'next queued');
  assert.strictEqual(collapsed, 1,
    `only the trailing EMPTY placeholder should be collapsed (not the non-empty tagged section); got ${collapsed}`);
  // Prior tagged section with body must survive verbatim.
  assert.ok(/## User Prompt \(From the Queue\)\n\nprior body\n/.test(next),
    'prior tagged section with body must be preserved');
  // Exactly two tagged sections total: the prior one + the freshly appended one.
  const taggedCount = (next.match(/## User Prompt \(From the Queue\)/g) || []).length;
  assert.strictEqual(taggedCount, 2, `expected 2 tagged sections; got ${taggedCount}`);
});

test('(4) appendUserPromptSuffixToFile-style guard refuses to add when file already ends with tagged placeholder', () => {
  // Source-level: appendUserPromptSuffixToFile must check the
  // tagged-or-untagged trailing-placeholder regex before appending.
  const tmp = path.join(os.tmpdir(), `harness-append-suffix-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmp,
      '# x\n\n## Coding Agent Response\n\nbody\n\n' +
      '---\n\n## User Prompt (From the Queue)\n\nq\n\n' +
      '---\n\n## User Prompt\n\n',
      'utf8');
    // Simulate the new appendUserPromptSuffixToFile guard.
    const existing = fs.readFileSync(tmp, 'utf8');
    const shouldSkip = TRAILING_PLACEHOLDER_PRESENT_RE.test(existing);
    assert.strictEqual(shouldSkip, true,
      'guard regex must report present-placeholder for a file ending in `## User Prompt`');

    // And against the tagged form WITHOUT a trailing untagged placeholder:
    fs.writeFileSync(tmp,
      '# x\n\n## Coding Agent Response\n\nbody\n\n' +
      '---\n\n## User Prompt (From the Queue)\n\n',
      'utf8');
    const existing2 = fs.readFileSync(tmp, 'utf8');
    assert.strictEqual(TRAILING_PLACEHOLDER_PRESENT_RE.test(existing2), true,
      'guard regex must also recognise tagged `(From the Queue)` form as present');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('(4b) source: appendUserPromptSuffixToFile invokes the tagged-form-aware guard', () => {
  const fn = runAgentSrc.match(/function appendUserPromptSuffixToFile\([\s\S]*?\n\}/);
  assert.ok(fn, 'appendUserPromptSuffixToFile must exist');
  const body = fn[0];
  assert.ok(body.includes('User Prompt(?:\\s+\\([^)]+\\))?'),
    'appendUserPromptSuffixToFile must use tagged-form-aware guard regex (matching parenthesised tag)');
});

test('(4c) source: appendToFile early-return guard recognises tagged form too', () => {
  const fn = runAgentSrc.match(/function appendToFile\([\s\S]*?\n\}/);
  assert.ok(fn, 'appendToFile must exist');
  const body = fn[0];
  assert.ok(body.includes('User Prompt(?:\\s+\\([^)]+\\))?'),
    'appendToFile guard regex must also accept parenthesised tag form');
});

test('(5) normalizeTrailingPromptStack on live-fixture tail collapses stacked headers to one', () => {
  // Mirrors claude_harness.md:5200-5213 — two stacked `## User Prompt` blocks
  // (one empty, one with body). Normalize should collapse to one EMPTY
  // placeholder (it is body-preserving only for empty placeholders — the
  // non-empty one stays intact, since the regex requires whitespace-only body).
  const tmp = path.join(os.tmpdir(), `harness-fixture-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmp,
      '# x\n\n' +
      '## Coding Agent Response (Remediation)\n\nsome body\n\n' +
      '*Model: claude-opus-4-7*\n\n' +
      '---\n\n## User Prompt\n\n' +
      '---\n\n## User Prompt\n\n',
      'utf8');
    const removed = normalizeTrailingPromptStack(tmp);
    assert.strictEqual(removed, 1, `expected 1 duplicate collapsed; got ${removed}`);
    const after = fs.readFileSync(tmp, 'utf8');
    const headerCount = (after.match(/^##\s+User Prompt/gm) || []).length;
    assert.strictEqual(headerCount, 1, `expected exactly 1 '## User Prompt' header after normalize; got ${headerCount}\n${after}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('(5b) normalizeTrailingPromptStack is idempotent on already-normalized file', () => {
  const tmp = path.join(os.tmpdir(), `harness-idem-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmp,
      '# x\n\n## Coding Agent Response\n\nbody\n\n' +
      '---\n\n## User Prompt\n\n',
      'utf8');
    const before = fs.readFileSync(tmp, 'utf8');
    const removed = normalizeTrailingPromptStack(tmp);
    assert.strictEqual(removed, 0, `idempotent: nothing to collapse; got ${removed}`);
    const after = fs.readFileSync(tmp, 'utf8');
    assert.strictEqual(after, before, 'file content must be unchanged when nothing to collapse');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

// ── Source-level wiring tests ───────────────────────────────────────────────

test('(6) run-agent.js dispatch calls normalizeTrailingPromptStack before fillEmptyPromptFromQueueOrInteractive', () => {
  const normIdx = runAgentSrc.indexOf('normalizeTrailingPromptStack(historyPath)');
  const fillIdx = runAgentSrc.indexOf('await fillEmptyPromptFromQueueOrInteractive()');
  assert.ok(normIdx > 0, 'expected normalizeTrailingPromptStack(historyPath) call in dispatch');
  assert.ok(fillIdx > 0, 'expected fillEmptyPromptFromQueueOrInteractive call in dispatch');
  assert.ok(normIdx < fillIdx, 'normalizeTrailingPromptStack must precede fillEmptyPromptFromQueueOrInteractive');
});

test('(7) injectQueuedPromptIntoHistory has NO branch-conditional (single unified branch)', () => {
  const fn = runAgentSrc.match(/function injectQueuedPromptIntoHistory\([\s\S]*?\n\}/);
  assert.ok(fn, 'injectQueuedPromptIntoHistory must exist');
  const body = fn[0];
  // The unified branch performs ONE write; it must not have an
  // `if (matched) { ... } else { ... }` reuse/fresh dichotomy. We assert the
  // absence of the legacy in-place replace pattern.
  assert.ok(!/txt\.replace\(trailingEmptyRe,/.test(body),
    'legacy in-place reuse-branch replace must be gone — unified branch strips ALL then appends ONE');
  assert.ok(/stripAllTrailingEmptyPlaceholders/.test(body),
    'unified branch must call stripAllTrailingEmptyPlaceholders helper');
});

test('(8) clear-memory.js exposes --normalize flag for retroactive cleanup', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'clear-memory.js'), 'utf8');
  assert.ok(/--normalize/.test(src), 'clear-memory.js must accept --normalize flag');
  assert.ok(/normalizeTrailingPromptStack/.test(src), 'clear-memory.js must invoke normalizeTrailingPromptStack');
});

test('(10) normalizeTrailingPromptStack collapses orphan empty `## User Prompt` IMMEDIATELY PRECEDING a non-empty one (live-fixture shape claude_harness.md:5207-5213)', () => {
  // The exact pattern QA flagged: an orphan empty `## User Prompt` header
  // sitting above a separator + a populated `## User Prompt` header. Previous
  // implementation collapsed only trailing-whitespace tails, leaving this
  // arrangement untouched. New impl must collapse the empty orphan.
  const tmp = path.join(os.tmpdir(), `harness-orphan-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmp,
      '# x\n\n' +
      '## Coding Agent Response (Remediation)\n\nsome body\n\n' +
      '*Model: claude-opus-4-7*\n\n' +
      '---\n\n## User Prompt\n\n' +
      '---\n\n## User Prompt\n\n' +
      'Incredibly, the issue is still there...\n\n' +
      '---\n\n## Planning Agent Response\n\n- foo\n',
      'utf8');
    const removed = normalizeTrailingPromptStack(tmp);
    assert.ok(removed >= 1, `expected at least 1 orphan empty header collapsed; got ${removed}`);
    const after = fs.readFileSync(tmp, 'utf8');
    // After collapse the populated User Prompt body must remain intact.
    assert.ok(/## User Prompt\n\nIncredibly, the issue is still there\.\.\./.test(after),
      `populated prompt block must survive collapse; got:\n${after}`);
    // The orphan empty `## User Prompt` directly above must be gone — i.e.
    // exactly ONE `## User Prompt` header preceding the populated body.
    const headers = after.match(/^##\s+User Prompt[^\n]*$/gm) || [];
    assert.strictEqual(headers.length, 1,
      `expected exactly 1 '## User Prompt' header after orphan collapse; got ${headers.length}\n${after}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('(10b) collapseInternalEmptyPromptHeaders helper is pure and exported', () => {
  const seeded =
    '## Coding Agent Response\n\nbody\n\n' +
    '---\n\n## User Prompt\n\n' +
    '---\n\n## User Prompt\n\nreal prompt\n';
  const { text, collapsed } = collapseInternalEmptyPromptHeaders(seeded);
  assert.strictEqual(collapsed, 1, `expected 1 orphan collapsed; got ${collapsed}`);
  const headers = text.match(/^##\s+User Prompt[^\n]*$/gm) || [];
  assert.strictEqual(headers.length, 1, `expected 1 header remaining; got ${headers.length}`);
  assert.ok(/## User Prompt\n\nreal prompt/.test(text), 'real body must survive');
});

test('(11) injectQueuedPromptIntoHistory emits ONE consolidated debug entry (no duplicate appendQueueInjectDebug call)', () => {
  const fn = runAgentSrc.match(/function injectQueuedPromptIntoHistory\([\s\S]*?\n\}/);
  assert.ok(fn, 'injectQueuedPromptIntoHistory must exist');
  const body = fn[0];
  const calls = (body.match(/appendQueueInjectDebug\(/g) || []).length;
  assert.strictEqual(calls, 1,
    `expected exactly 1 appendQueueInjectDebug call in injectQueuedPromptIntoHistory; got ${calls}`);
  assert.ok(/unified:\s*true/.test(body),
    'consolidated debug entry must carry `unified: true` flag for telemetry');
  assert.ok(/branch:\s*collapsed\s*>\s*0\s*\?\s*'reuse'\s*:\s*'fresh-append'/.test(body),
    'branch label must retain legacy reuse/fresh-append continuity');
});

if (_failed === 0) console.log('\nAll queue-inject-no-duplicates tests passed.');
else console.error(`\n${_failed} test(s) failed.`);
