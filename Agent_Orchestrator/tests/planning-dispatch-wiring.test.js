#!/usr/bin/env node
'use strict';

// Regression tests for planning-agent dispatch wiring — guards the full pipeline from
// injectQueuedPromptIntoHistory through parseConversationContext to the payload passed
// to runClaude. Prior bug: planning agent ignored the dequeued prompt body and responded
// to the wider conversation thread instead (hypothesis: Topic Context directive told agent
// to read the history file, which contains the full thread and biases agent response).
//
// Coverage:
//   (a) end-to-end: inject SENTINEL body -> parseConversationContext returns it verbatim
//   (b) source: runPlanning calls parseConversationContext(historyPath) and passes result to buildPayload
//   (c) source: runPlanning passes activeHistoryRel to buildContextSection (fix-ii — prevents agent reading history file)
//   (d) source: injectQueuedPromptIntoHistory emits post-write SHA-256 debug log
//   (e) source: runPlanning emits pre-runClaude SHA-256 file-state debug log
//   (f) source: buildContextSection accepts activeHistoryRel and appends do-not-read note
//
// Run: node Agent_Orchestrator/tests/planning-dispatch-wiring.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── Helpers mirrored from run-agent.js / normalize-history.js ────────────────

const ANY_RESPONSE_HEADER = '(?:Planning|Coding|Assessment)\\s+Agent(?:\\s+\\d+)?\\s+Response(?:\\s*\\(Remediation(?:\\s+task-\\d+)?\\))?(?:\\s*\\(task-\\d+\\))?';
const CONTEXT_TRUNCATION = 400;

function parseConversationContext(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const clearMarker = '--- CLEAR CONTEXT ---';
  const lastClearIdx = content.lastIndexOf(clearMarker);
  const raw = lastClearIdx >= 0 ? content.slice(lastClearIdx + clearMarker.length) : content;
  const MASK = '\x00##';
  const masked = raw.replace(/`{3}[\s\S]*?`{3}/g, block => block.replace(/^##/gm, MASK));
  const headerSplit = new RegExp(`^(##\\s+(?:User Prompt(?:\\s+\\([^)\\n]*\\))?|User Reply to Questions|Auto Reply to Clarifying Questions|Auto Answer|${ANY_RESPONSE_HEADER}))\\s*$`, 'gim');
  const parts = masked.split(headerSplit);
  if (parts.length < 3) return null;
  let blocks = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const header = parts[i].trim();
    const text = parts[i + 1].replace(/\x00##/g, '##').replace(/\n---\s*$/, '').trim();
    if (text) blocks.push({ header, text });
  }
  if (!blocks.some(b => /user prompt/i.test(b.header))) return null;
  let lastUserPromptIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (/^##\s+User Prompt\b/i.test(blocks[i].header.trim())) lastUserPromptIdx = i;
  }
  if (lastUserPromptIdx >= 0) blocks = blocks.slice(lastUserPromptIdx);
  return blocks.map(block => {
    let text = block.text;
    if (/agent response/i.test(block.header)) {
      text = text.replace(/\n\n\*Model:[\s\S]*?\*\s*$/, '');
      if (text.length > CONTEXT_TRUNCATION) text = text.slice(0, CONTEXT_TRUNCATION) + '\n...[truncated to save tokens]';
    }
    return `${block.header}\n\n${text}`;
  }).join('\n\n');
}

// Real inject logic from normalize-history (not hand-rolled) — test (a) exercises
// the same transformation path as injectQueuedPromptIntoHistory.
const { buildQueueInjectedContent } = require('../src/normalize-history');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-dispatch-test-'));
function tmpFile(name, contents) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, contents, 'utf8');
  return p;
}

// ── (a) End-to-end: inject -> parse -> SENTINEL present ──────────────────────

test('(a) inject SENTINEL body then parseConversationContext returns it verbatim', () => {
  const SENTINEL = 'SENTINEL-DISPATCH-WIRING-XYZ';
  const initial = '# test\n\n## Coding Agent Response\n\nprior work\n\n---\n\n## User Prompt\n\n';
  const injected = buildQueueInjectedContent(initial, SENTINEL);
  const f = tmpFile('a.md', injected);
  const ctx = parseConversationContext(f);
  assert.ok(ctx, 'parseConversationContext must return non-null after inject');
  assert.ok(ctx.includes(SENTINEL), `parsed context must contain sentinel body; got:\n${ctx}`);
  assert.ok(!ctx.includes('prior work'), 'stale prior response must be dropped');
  assert.ok(/^## User Prompt \(From the Queue\)/.test(ctx), 'context must start with the tagged header');
});

// ── (b) Source: runPlanning wires context -> buildPayload userPrompt ──────────

test('(b) source: runPlanning calls parseConversationContext(historyPath) before buildPayload', () => {
  const planStart = runAgentSrc.indexOf('async function runPlanning(');
  assert.ok(planStart >= 0, 'runPlanning must exist');
  const nextFn = runAgentSrc.indexOf('\nasync function ', planStart + 1);
  const fnBody = nextFn > 0 ? runAgentSrc.slice(planStart, nextFn) : runAgentSrc.slice(planStart);
  const pccIdx = fnBody.indexOf('const context = parseConversationContext(historyPath)');
  const bpIdx = fnBody.indexOf('buildPayload(');
  assert.ok(pccIdx >= 0, 'runPlanning must call parseConversationContext(historyPath)');
  assert.ok(bpIdx >= 0, 'runPlanning must call buildPayload');
  assert.ok(pccIdx < bpIdx, 'parseConversationContext must precede buildPayload call');
  assert.ok(fnBody.includes(', context,'), 'buildPayload call must pass context as userPrompt arg');
});

// ── (c) Source: fix-ii — buildContextSection receives activeHistoryRel ────────

test('(c) source: runPlanning passes historyRel to buildContextSection (fix-ii)', () => {
  const planStart = runAgentSrc.indexOf('async function runPlanning(');
  assert.ok(planStart >= 0, 'runPlanning must exist');
  const nextFn = runAgentSrc.indexOf('\nasync function ', planStart + 1);
  const fnBody = nextFn > 0 ? runAgentSrc.slice(planStart, nextFn) : runAgentSrc.slice(planStart);
  assert.ok(
    fnBody.includes('buildContextSection(topicConfig.contextFiles, historyRel)'),
    'runPlanning must pass historyRel to buildContextSection to prevent agent reading history file directly'
  );
  assert.ok(
    fnBody.includes('path.relative(ROOT, historyPath)'),
    'runPlanning must compute historyRel via path.relative'
  );
});

// ── (d) Source: post-write SHA-256 log in injectQueuedPromptIntoHistory ───────

test('(d) source: injectQueuedPromptIntoHistory emits post-write SHA-256 debug log', () => {
  const injectIdx = runAgentSrc.indexOf('function injectQueuedPromptIntoHistory(');
  assert.ok(injectIdx >= 0, 'injectQueuedPromptIntoHistory must exist');
  const releaseIdx = runAgentSrc.indexOf('releaseFileLock(lock)', injectIdx);
  const fnBody = runAgentSrc.slice(injectIdx, releaseIdx);
  assert.ok(fnBody.includes('injectQueuedPromptIntoHistory[postWrite]'),
    'injectQueuedPromptIntoHistory must emit postWrite debug log');
  assert.ok(fnBody.includes('sha256'), 'postWrite log must include sha256');
  assert.ok(fnBody.includes('tailRaw'), 'postWrite log must include tailRaw for tail inspection');
});

// ── (e) Source: runPlanning has SHA-256 file-state debug log ─────────────────

test('(e) source: runPlanning emits SHA-256 file-state debug log before runClaude', () => {
  const planStart = runAgentSrc.indexOf('async function runPlanning(');
  assert.ok(planStart >= 0, 'runPlanning must exist');
  const nextFn = runAgentSrc.indexOf('\nasync function ', planStart + 1);
  const fnBody = nextFn > 0 ? runAgentSrc.slice(planStart, nextFn) : runAgentSrc.slice(planStart);
  assert.ok(fnBody.includes('runPlanning:') && fnBody.includes('historyFileSha256'),
    'runPlanning must emit SHA-256 file-state debug log');
  assert.ok(fnBody.includes('contextHead'), 'debug log must include contextHead for prompt verification');
  assert.ok(fnBody.includes('contextTail'), 'debug log must include contextTail for prompt verification');
  const logIdx = fnBody.indexOf('historyFileSha256');
  const runClaudeIdx = fnBody.indexOf('await runClaude(');
  assert.ok(logIdx < runClaudeIdx, 'SHA-256 log must precede runClaude invocation');
});

// ── (f) Source: buildContextSection structurally excludes activeHistoryRel ────

test('(f) source: buildContextSection structurally filters activeHistoryRel and emits do-not-read note', () => {
  assert.ok(
    /function buildContextSection\(contextEntries,\s*activeHistoryRel\s*=\s*null\)/.test(runAgentSrc),
    'buildContextSection must declare activeHistoryRel parameter with null default'
  );
  // Structural exclusion: the function must filter the history path from context paths,
  // not only emit an instructional note. Without this filter, the agent can enumerate
  // the topic directory and read the history file despite the note.
  const buildCtxIdx = runAgentSrc.indexOf('function buildContextSection(');
  assert.ok(buildCtxIdx >= 0, 'buildContextSection must exist');
  const buildCtxEnd = runAgentSrc.indexOf('\nfunction ', buildCtxIdx + 1);
  const fnBody = runAgentSrc.slice(buildCtxIdx, buildCtxEnd > 0 ? buildCtxEnd : buildCtxIdx + 1200);
  assert.ok(
    fnBody.includes('!== activeHistoryRel') || (fnBody.includes('.filter(') && fnBody.includes('activeHistoryRel')),
    'buildContextSection must structurally filter activeHistoryRel from context paths (not only an instructional note)'
  );
  assert.ok(runAgentSrc.includes('Do NOT open or read'),
    'buildContextSection must also emit do-not-read note when activeHistoryRel provided'
  );
  assert.ok(runAgentSrc.includes('already embedded in the User Prompt above'),
    'do-not-read note must explain why (content already in user prompt)'
  );
});

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

if (_failed === 0) console.log('\nAll planning-dispatch-wiring tests passed.');
else console.error(`\n${_failed} test(s) failed.`);
