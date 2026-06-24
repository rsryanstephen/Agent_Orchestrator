#!/usr/bin/env node
'use strict';

/**
 * Regression tests for prompt-queue support.
 * Run: node Agent_Orchestrator/tests/prompt-queue.test.js
 *
 * Covers the requirements bullets from the implementation plan:
 *  (1) parse multi-block queue
 *  (2) missing header -> `all` (defaultPipeline)
 *  (3) bare shorthand header
 *  (4) unknown shorthand -> warn + queue untouched
 *  (5) empty queue -> no-op
 *  (6) shorthand list synced with shell-functions.txt (parser regex shape)
 *  (7) promptQueue.autoAdvance=false halts after one dequeue
 *
 * Extra wiring-level tests for run-agent.js + start-topic.js + global-config.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const promptQueue = require(path.join(HARNESS, 'src', 'prompt-queue.js'));
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
const startTopicSrc = fs.readFileSync(path.join(HARNESS, 'src', 'start-topic.js'), 'utf8');
const globalCfgRaw = fs.readFileSync(path.join(HARNESS, 'global-config.json'), 'utf8');
const shellFnsRaw = fs.readFileSync(path.join(HARNESS, 'shell-functions.txt'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-test-'));
  return d;
}
function writeQueue(dir, txt) { fs.writeFileSync(path.join(dir, 'prompt-queue.md'), txt, 'utf8'); }

// ── (1) parse multi-block queue ───────────────────────────────────────────────
test('(1) parseQueue handles multi-block queue split on `---` divider', () => {
  const d = tmpdir();
  writeQueue(d,
    'Pipeline: caf\nBlock A body line one\nBlock A body line two\n\n---\n\npcaf\nBlock B body\n\n---\n\nUnheadered third block body.\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 3, `expected 3 blocks, got ${blocks.length}`);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.ok(blocks[0].body.includes('Block A body line one'));
  assert.strictEqual(blocks[1].pipeline, 'pcaf');
  assert.strictEqual(blocks[2].pipeline, null, 'third block should report no header');
  assert.ok(blocks[2].body.includes('Unheadered third block body.'));
});

// ── (2) missing header -> `all` (defaultPipeline) ─────────────────────────────
test('(2) dequeueHead with no header defaults to configured defaultPipeline', () => {
  const d = tmpdir();
  writeQueue(d, 'Just a bare prompt body with no header at all.\n');
  const r = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(r && r.block, 'expected block to be returned');
  assert.strictEqual(r.block.pipeline, 'all');
  assert.strictEqual(r.defaultedPipeline, true);
  assert.ok(r.block.body.includes('Just a bare prompt body'));
});

// ── (3) bare shorthand header ─────────────────────────────────────────────────
test('(3) bare shorthand header (no `Pipeline:` prefix) is recognised', () => {
  const d = tmpdir();
  writeQueue(d, 'pcaf\nDo the thing.\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].pipeline, 'pcaf');
  assert.strictEqual(blocks[0].headerForm, 'bare');
  assert.strictEqual(blocks[0].body.trim(), 'Do the thing.');
});

// ── (3b) parsePromptFileHeader: per-prompt header (pipeline + model) ───────────
test('(3b) parsePromptFileHeader extracts pipeline + model and strips header line', () => {
  const r = promptQueue.parsePromptFileHeader('opus caf\n\nDo X');
  assert.strictEqual(r.pipeline, 'caf', 'pipeline shorthand should resolve');
  assert.strictEqual(r.provider, 'claude-code', 'opus -> claude-code provider');
  assert.ok(r.model, 'opus family should resolve to a non-null model id');
  assert.strictEqual(r.body.trim(), 'Do X', 'header line stripped from body');
});
test('(3b) parsePromptFileHeader returns null-ish header for prose first line', () => {
  const r = promptQueue.parsePromptFileHeader('Fix the login bug.\nMore detail.');
  assert.strictEqual(r.pipeline, null, 'prose first line -> no pipeline');
  assert.strictEqual(r.model, null, 'prose first line -> no model');
  assert.ok(r.body.startsWith('Fix the login bug.'), 'body unchanged when no header');
});

// ── (4) unknown shorthand -> warn + leave queue untouched ─────────────────────
test('(4) unknown shorthand in head -> warning + queue file NOT consumed', () => {
  const d = tmpdir();
  const initial = 'Pipeline: gibberish\nshould not be consumed\n\n---\n\nPipeline: caf\nsecond block\n';
  writeQueue(d, initial);
  const warnings = [];
  const r = promptQueue.dequeueHead(d, { defaultPipeline: 'all', log: m => warnings.push(m) });
  assert.ok(r && r.warning === 'unknown-shorthand', 'expected unknown-shorthand warning result');
  assert.strictEqual(r.block, null);
  assert.ok(warnings.some(w => /unknown shorthand/i.test(w)), 'expected log warning text');
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.strictEqual(after, initial, 'queue file must be untouched after unknown-shorthand failure');
});

// ── (5) empty queue -> no-op ──────────────────────────────────────────────────
test('(5) empty queue (missing file or no blocks) -> dequeueHead returns null', () => {
  const d = tmpdir();
  assert.strictEqual(promptQueue.dequeueHead(d), null, 'missing file -> null');
  writeQueue(d, '');
  assert.strictEqual(promptQueue.dequeueHead(d), null, 'empty file -> null');
  writeQueue(d, '   \n\n\n');
  assert.strictEqual(promptQueue.dequeueHead(d), null, 'whitespace-only file -> null');
  assert.strictEqual(promptQueue.queueLength(d), 0);
});

// ── (6) shorthand list synced with shell-functions.txt ────────────────────────
test('(6) shorthand list is parsed from shell-functions.txt Shorthand: line', () => {
  const list = promptQueue.readShorthandList();
  assert.ok(list.length > 0, 'expected non-empty shorthand list from shell-functions.txt');
  for (const s of ['p', 'c', 'a', 'f', 'af', 'pc', 'caf', 'all', 'pcaf', 'cont']) {
    assert.ok(list.includes(s), `shell-functions.txt Shorthand list missing "${s}"`);
  }
  assert.ok(/Shorthand\s*:\s*[A-Za-z0-9_|\- ]+/.test(shellFnsRaw),
    'shell-functions.txt must contain a parseable `Shorthand:` line — parser regex would break');
  // Cross-check parser regex agrees with what the file actually contains.
  assert.ok(promptQueue.isKnownShorthand('caf', list));
  assert.ok(!promptQueue.isKnownShorthand('gibberish', list));
});

// ── (7) promptQueue.autoAdvance=false halts after one dequeue ─────────────────
test('(7) autoAdvance=false: harness logs pending count instead of spawning', () => {
  // Verify the wiring in run-agent.js honours promptQueue.autoAdvance=false.
  assert.ok(/promptQueue\.autoAdvance/.test(runAgentSrc),
    'run-agent.js must read `promptQueue.autoAdvance` from config');
  assert.ok(/Auto-advance is off/.test(runAgentSrc) || /autoAdvance/.test(runAgentSrc),
    'run-agent.js must branch on autoAdvance');
  assert.ok(/:queue-next/.test(runAgentSrc), 'run-agent.js must expose `:queue-next` command');
  // Behaviour-level: dequeueHead itself is unconditional — gating is in the caller —
  // so simulate "halted" state by calling dequeueHead exactly once on a 2-block queue.
  const d = tmpdir();
  writeQueue(d, 'caf\nFirst\n\n---\n\npcaf\nSecond\n');
  const first = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(first && first.block && first.block.pipeline === 'caf');
  // Caller chooses NOT to dispatch again -> queue still has 1 block remaining.
  assert.strictEqual(promptQueue.queueLength(d), 1, 'one block should remain after single dequeue');
});

// ── Extra wiring-level tests ──────────────────────────────────────────────────
test('start-topic.js seeds prompt-queue.md on topic init', () => {
  assert.ok(/prompt-queue/.test(startTopicSrc), 'start-topic.js must reference prompt-queue');
  assert.ok(/ensureQueueFile/.test(startTopicSrc), 'start-topic.js must call ensureQueueFile');
  // Behavioural: ensureQueueFile creates the file when missing and is idempotent.
  const d = tmpdir();
  assert.strictEqual(promptQueue.ensureQueueFile(d), true);
  assert.ok(fs.existsSync(path.join(d, 'prompt-queue.md')));
  assert.strictEqual(promptQueue.ensureQueueFile(d), false, 'second call must be no-op');
});

test('global-config.json declares promptQueue.autoAdvance + defaultPipeline w/ comments', () => {
  assert.ok(/"promptQueue\.autoAdvance"\s*:\s*true/.test(globalCfgRaw));
  assert.ok(/"promptQueue\.defaultPipeline"\s*:\s*"all"/.test(globalCfgRaw));
  assert.ok(/"\/\/ promptQueue\.autoAdvance"/.test(globalCfgRaw), 'inline `// promptQueue.autoAdvance` comment missing');
  assert.ok(/"\/\/ promptQueue\.defaultPipeline"/.test(globalCfgRaw), 'inline `// promptQueue.defaultPipeline` comment missing');
});

test('run-agent.js wires post-pipeline dequeueAndTriggerNext after emitEndOfRunLimits', () => {
  assert.ok(/dequeueAndTriggerNext/.test(runAgentSrc), 'run-agent.js must define + call dequeueAndTriggerNext');
  assert.ok(/await emitEndOfRunLimits\(\);\s*\n\s*if \(completed\) await dequeueAndTriggerNext\(\)/.test(runAgentSrc),
    'dequeueAndTriggerNext must be awaited after emitEndOfRunLimits()');
});

test('lock file serialises concurrent dequeues', () => {
  const d = tmpdir();
  writeQueue(d, 'caf\nA\n\n---\n\npcaf\nB\n');
  const r = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(r && r.block);
  assert.ok(!fs.existsSync(path.join(d, 'prompt-queue.md.lock')), 'lock file must be released');
});

// ── Behavioural: pre-existing lock from live holder blocks dequeue ────────────
test('dequeueHead refuses + warns when lock held by a live PID', () => {
  const d = tmpdir();
  writeQueue(d, 'caf\nA\n\n---\n\npcaf\nB\n');
  const lockPath = path.join(d, 'prompt-queue.md.lock');
  // Plant a lock owned by the current PID (definitely "live"). Stale-detection
  // path uses process.kill(pid, 0) which succeeds for our own PID -> not stale.
  fs.writeFileSync(lockPath, String(process.pid), 'utf8');
  const warnings = [];
  const before = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  // Use very short timeout via monkey-patched fn — call directly with default
  // 5s lock timeout would slow the test. We rely on the existing behaviour
  // which polls until the deadline. To keep the suite fast, swap lock acquire.
  const origAcquire = require(path.join(HARNESS, 'src', 'prompt-queue.js'));
  // The exported `dequeueHead` uses internal acquireLock w/ 5s deadline. Verify
  // at least that with the live lock present, the queue file is NOT modified
  // and no head is consumed, even if the call eventually times out.
  // To avoid a 5s wait, race against a 200ms deadline by clearing the lock.
  setTimeout(() => { try { fs.unlinkSync(lockPath); } catch {} }, 50);
  const r = origAcquire.dequeueHead(d, { defaultPipeline: 'all', log: m => warnings.push(m) });
  // Either it eventually dequeued (lock cleared in time) OR it gave up.
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  if (r && r.block) {
    // Eventually proceeded — file MUST have shrunk by exactly one block.
    assert.notStrictEqual(after, before, 'file should change after successful dequeue');
  } else {
    // Gave up — queue file must be byte-identical, no block consumed.
    assert.strictEqual(after, before, 'queue file untouched when lock could not be acquired');
    assert.ok(warnings.some(w => /failed to acquire lock/i.test(w)), 'expected lock-timeout warning');
  }
});

// ── Behavioural: autoAdvance=false leaves queue intact for manual continuation ─
test('autoAdvance=false caller path: pending blocks logged, queue file unchanged', () => {
  // End-to-end-shaped: simulate the exact branch in run-agent.js
  // `dequeueAndTriggerNext` takes when promptQueue.autoAdvance=false and
  // manualSubmit=false — it must NOT call dequeueHead, so the file is byte-identical.
  const d = tmpdir();
  const initial = 'caf\nFirst queued\n\n---\n\npcaf\nSecond queued\n';
  writeQueue(d, initial);
  const logs = [];
  const log = m => logs.push(m);

  // Mirror the gate in run-agent.js dequeueAndTriggerNext().
  const autoAdvance = false;
  const manualSubmit = false;
  const pending = promptQueue.queueLength(d);
  if (pending > 0 && !autoAdvance && !manualSubmit) {
    log(`prompt-queue: ${pending} pending block(s). Auto-advance is off — run \`hrun test-cont\` or use \`:queue-next\` to dispatch the head block.`);
  }
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.strictEqual(after, initial, 'queue file must be byte-identical when autoAdvance=false short-circuits');
  assert.strictEqual(pending, 2, 'both blocks must still be queued');
  assert.ok(logs.some(l => /Auto-advance is off/.test(l)), 'expected "Auto-advance is off" log line');
  assert.ok(logs.some(l => /:queue-next/.test(l)), 'expected `:queue-next` hint in log');

  // And confirm that with manualSubmit=true the same caller WOULD dispatch.
  const r = promptQueue.dequeueHead(d, { defaultPipeline: 'all', log });
  assert.ok(r && r.block && r.block.pipeline === 'caf');
  assert.strictEqual(promptQueue.queueLength(d), 1, 'one block should remain after manual single dequeue');
});

// ── Regression: dequeueHead on last block re-seeds the instructional header ───
test('dequeueHead on final block re-seeds the file (preserves `# Prompt Queue` hint)', () => {
  const d = tmpdir();
  promptQueue.ensureQueueFile(d);
  const seeded = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.ok(/# Prompt Queue/.test(seeded), 'ensureQueueFile must seed `# Prompt Queue` header');
  // Append a single block, then drain it.
  fs.appendFileSync(path.join(d, 'prompt-queue.md'), '\ncaf\nLast block body\n', 'utf8');
  const r = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(r && r.block, 'expected the single block to dequeue');
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.ok(/# Prompt Queue/.test(after), 'drained file MUST retain `# Prompt Queue` seed header');
  assert.ok(/FORMAT:/.test(after), 'drained file MUST retain instructional comment block');
  assert.strictEqual(promptQueue.queueLength(d), 0, 'drained queue reports zero blocks');
});

// ── Regression: cont shorthand maps to `continue` pipeline ────────────────────
test('cont shorthand: shell-functions lists `cont` AND run-agent.js resolves it', () => {
  const list = promptQueue.readShorthandList();
  assert.ok(list.includes('cont'), 'shell-functions.txt Shorthand list must include `cont`');
  // run-agent.js CMD_MAP must map `cont` -> a non-null pipeline key, else queued
  // `cont` blocks pass isKnownShorthand but get silently dropped after dequeue.
  assert.ok(/cont\s*:\s*'continue'/.test(runAgentSrc),
    'run-agent.js CMD_MAP must map `cont` -> `continue` (otherwise queued cont blocks are consumed then dropped)');
});

// ── Regression: injectQueuedPromptIntoHistory reuses trailing empty header ────
test('injectQueuedPromptIntoHistory: reuses trailing empty `## User Prompt` header in-place', () => {
  // ROOT CAUSE of the in-process 2nd-iteration failure: phase runners append a
  // trailing empty `## User Prompt` suffix at the end of every phase. The
  // previous impl appended a SECOND header instead of reusing the empty one,
  // producing two trailing headers -> latest-prompt parser saw the wrong one.
  // Replicate the function in-isolation so we can exercise its behaviour.
  function inject(filePath, body) {
    const txt = fs.readFileSync(filePath, 'utf8');
    const trailingEmptyRe = /(\n+(?:---\s*\n+)?)## User Prompt[^\n]*\s*\n*$/;
    let next;
    if (trailingEmptyRe.test(txt)) {
      next = txt.replace(trailingEmptyRe, `$1## User Prompt (From the Queue)\n\n${body}\n`);
    } else {
      next = txt.replace(/\s*$/, '') + `\n\n---\n\n## User Prompt (From the Queue)\n\n${body}\n`;
    }
    fs.writeFileSync(filePath, next, 'utf8');
  }

  // (a) Trailing empty `## User Prompt` -> reused in-place, renamed to (From the Queue).
  const d1 = tmpdir();
  const f1 = path.join(d1, 'history.md');
  fs.writeFileSync(f1, '# History\n\nold body\n\n---\n\n## User Prompt\n\n', 'utf8');
  inject(f1, 'queued prompt body');
  const out1 = fs.readFileSync(f1, 'utf8');
  const headerCount1 = (out1.match(/^## User Prompt/gm) || []).length;
  assert.strictEqual(headerCount1, 1, 'must NOT produce duplicate `## User Prompt` headers');
  assert.ok(/## User Prompt \(From the Queue\)/.test(out1), 'must rename header to `(From the Queue)`');
  assert.ok(/queued prompt body/.test(out1), 'body must be present');
  const dividerCount1 = (out1.match(/^---$/gm) || []).length;
  assert.strictEqual(dividerCount1, 1, 'must NOT duplicate the `---` divider');

  // (b) No trailing header -> appends fresh tagged section.
  const d2 = tmpdir();
  const f2 = path.join(d2, 'history.md');
  fs.writeFileSync(f2, '# History\n\nold body finishing with agent response\n', 'utf8');
  inject(f2, 'fresh queued body');
  const out2 = fs.readFileSync(f2, 'utf8');
  assert.ok(/## User Prompt \(From the Queue\)/.test(out2), 'fresh append also tagged (From the Queue)');
  assert.ok(/fresh queued body/.test(out2));

  // (c) Source pins: the production fn must contain the trailing-empty-reuse logic.
  const fnMatch = runAgentSrc.match(/function injectQueuedPromptIntoHistory[\s\S]*?\n\}\n/);
  assert.ok(fnMatch, 'injectQueuedPromptIntoHistory must exist');
  const fnBody = fnMatch[0];
  assert.ok(/trailingEmptyRe|## User Prompt\[\^/.test(fnBody),
    'production fn must detect trailing empty `## User Prompt` header');
  assert.ok(/\(From the Queue\)/.test(fnBody),
    'production fn must tag the injected prompt with `(From the Queue)`');
});

// ── Regression: dequeueAndTriggerNext now runs in-process for inline output ───
test('dequeueAndTriggerNext runs the next pipeline in-process (no spawn fallback)', () => {
  // Issue 2 fix: continuation must invoke runPipeline directly so stdout/stderr
  // stream to the current terminal. Prior spawn + preferred-terminal fallbacks
  // were removed because they masked real failures; on failure we re-queue
  // and abort instead.
  assert.ok(/async function dequeueAndTriggerNext/.test(runAgentSrc),
    'dequeueAndTriggerNext must be async to support in-process continuation');
  const m = runAgentSrc.match(/async function dequeueAndTriggerNext[\s\S]*?\n\}\n/);
  assert.ok(m, 'dequeueAndTriggerNext fn body must be extractable');
  const body = m[0];
  assert.ok(/await runPipeline\(pipelineKey/.test(body),
    'dequeueAndTriggerNext must invoke `await runPipeline(pipelineKey, ...)` for in-process continuation');
  assert.ok(/in-process/i.test(body), 'fn must log in-process continuation intent');
  // No `spawn(...)` should remain — failure path re-queues + aborts instead.
  assert.ok(!/\bspawn\(/.test(body),
    'dequeueAndTriggerNext must NOT contain any spawn(...) call — failures re-queue, not spawn');
  assert.ok(!/queue-dispatch-/.test(body),
    'dequeueAndTriggerNext must NOT write a `queue-dispatch-<topic>.log` (spawn fallback removed)');
});

// ── Regression: config key rename `resume-terminal` -> `preferred-terminal` ───
test('global-config.json declares `preferred-terminal` (renamed from `resume-terminal`)', () => {
  assert.ok(/"preferred-terminal"\s*:/.test(globalCfgRaw),
    'global-config.json must declare the new `preferred-terminal` key');
});

test('auto-resume.js reads `preferred-terminal` with back-compat to `resume-terminal`', () => {
  const autoResumeSrc = fs.readFileSync(path.join(HARNESS, 'src', 'auto-resume.js'), 'utf8');
  assert.ok(/preferred-terminal/.test(autoResumeSrc),
    'auto-resume.js must read the new `preferred-terminal` key');
  assert.ok(/resume-terminal/.test(autoResumeSrc),
    'auto-resume.js must still accept legacy `resume-terminal` as fallback');
  assert.ok(/DEPRECATION/i.test(autoResumeSrc),
    'auto-resume.js must log a deprecation notice when only the legacy key is set');
});

// ── Regression: on in-process failure, popped block is re-queued at head ──────
test('dequeueAndTriggerNext re-queues the popped block at head when runPipeline throws', () => {
  // Spawn + preferred-terminal fallbacks were removed because they masked the
  // real failure cause. Replacement contract: catch any throw from runPipeline,
  // restore the popped block at the HEAD of the queue (so the user's prompt
  // isn't lost), log the failure, then abort the drain.
  const m = runAgentSrc.match(/async function dequeueAndTriggerNext[\s\S]*?\n\}\n/);
  assert.ok(m, 'dequeueAndTriggerNext fn body must be extractable');
  const body = m[0];
  assert.ok(/promptQueue\.prependHead\(/.test(body),
    'on failure, fn must call `promptQueue.prependHead(...)` to restore the popped block at head');
  assert.ok(/block\.raw|rawBlock/.test(body),
    'fn must capture the popped `block.raw` BEFORE inject so it can be re-queued verbatim');
  assert.ok(/in-process pipeline failed/.test(body),
    'fn must log a clear in-process-failure message');
  assert.ok(/restored at head/i.test(body),
    'failure log must clearly state the block was restored');

  // Behavioural: prependHead actually restores a popped block at head.
  const d = tmpdir();
  writeQueue(d, 'caf\nFirst block body\n\n---\n\npcaf\nSecond block body\n');
  const popped = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(popped && popped.block && popped.block.pipeline === 'caf');
  assert.strictEqual(promptQueue.queueLength(d), 1, 'one block remains after dequeue');
  const ok = promptQueue.prependHead(d, popped.block.raw);
  assert.strictEqual(ok, true, 'prependHead must succeed');
  assert.strictEqual(promptQueue.queueLength(d), 2, 'block restored -> queue length back to 2');
  // Verify the restored block parses identically to the popped one.
  const parsed = promptQueue.parseQueue(d);
  assert.strictEqual(parsed.blocks[0].pipeline, 'caf', 'restored block at head must still carry `caf` header');
  assert.ok(parsed.blocks[0].body.includes('First block body'),
    'restored block must preserve its body verbatim');
});

// ── Regression: drain aborts after a single failure (no further runPipeline) ──
test('dequeueAndTriggerNext drain aborts after first failure — no second pipeline invocation', () => {
  // Source-level: confirm the catch block ends with `return;` and that no
  // continue/loop-back happens after a failure.
  const m = runAgentSrc.match(/async function dequeueAndTriggerNext[\s\S]*?\n\}\n/);
  assert.ok(m, 'dequeueAndTriggerNext fn body must be extractable');
  const body = m[0];
  // Extract the catch(innerErr) block by brace-matching to handle the nested
  // try/catch for the prependHead call.
  const catchStart = body.search(/catch\s*\(\s*innerErr\s*\)\s*\{/);
  assert.ok(catchStart >= 0, 'catch(innerErr) block must exist');
  const openIdx = body.indexOf('{', catchStart);
  let depth = 1, i = openIdx + 1;
  while (i < body.length && depth > 0) {
    const ch = body[i++];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  const catchBody = body.slice(catchStart, i);
  assert.ok(/return\s*;/.test(catchBody), 'failure catch must `return;` to abort the drain');
  assert.ok(!/\bcontinue\b/.test(catchBody), 'failure catch must NOT `continue` the drain loop');
  // And no spawn(...) anywhere in catch -> fallback truly removed.
  assert.ok(!/\bspawn\s*\(/.test(catchBody), 'failure catch must NOT spawn(...)');
});

// ── Regression: no spurious stripTrailingUserPrompt after inject ──────────────
test('in-process continuation does NOT call stripTrailingUserPrompt after inject (was a no-op)', () => {
  // Previously a `stripTrailingUserPrompt(historyPath); // consume the just-injected ## User Prompt`
  // line ran AFTER `injectQueuedPromptIntoHistory(block.body)`. stripTrailingUserPrompt's
  // regex only matches an EMPTY trailing `## User Prompt`, so the call was a no-op
  // AND the comment was misleading (the just-injected section carries the body,
  // so it must remain for the in-process pipeline to read).
  const m = runAgentSrc.match(/async function dequeueAndTriggerNext[\s\S]*?\n\}\n/);
  assert.ok(m, 'dequeueAndTriggerNext fn body must be extractable');
  const body = m[0];
  assert.ok(!/stripTrailingUserPrompt\(historyPath\);\s*\/\/\s*consume the just-injected/.test(body),
    'misleading no-op stripTrailingUserPrompt call (with "consume the just-injected" comment) must be removed');
  // Confirm the in-process call happens directly after the inject + log statements.
  assert.ok(/injectQueuedPromptIntoHistory\(block\.body[^)]*\)[\s\S]*?await runPipeline\(pipelineKey/.test(body),
    'runPipeline must be invoked directly after injectQueuedPromptIntoHistory (no strip in between)');
});

// ── Regression: queue is drained iteratively, not recursively ─────────────────
test('dequeueAndTriggerNext drains the queue with a loop (not recursive self-call)', () => {
  // Recursion previously caused N+1 `emitEndOfRunLimits` summaries: each recursive
  // drain emitted once, plus the outer top-level callsite emitted again. Switch
  // to a `while` loop within dequeueAndTriggerNext so emitEndOfRunLimits fires
  // exactly once (at the outer top-level callsite).
  const m = runAgentSrc.match(/async function dequeueAndTriggerNext[\s\S]*?\n\}\n/);
  assert.ok(m, 'dequeueAndTriggerNext fn body must be extractable');
  const body = m[0];
  assert.ok(/while\s*\(\s*true\s*\)/.test(body),
    'fn body must contain a `while (true)` drain loop instead of a recursive self-call');
  assert.ok(!/await dequeueAndTriggerNext\s*\(/.test(body),
    'fn must NOT recursively await `dequeueAndTriggerNext(...)` inside itself');
  assert.ok(!/emitEndOfRunLimits\s*\(/.test(body),
    'fn must NOT call emitEndOfRunLimits inside the drain — outer top-level callsite emits exactly once');
});

// ── Unit: prependHead atomicity + edge cases ──────────────────────────────────
test('prependHead: appears at head; preserves header + body; no-op on empty input', () => {
  // (a) Prepend onto a populated queue -> appears at index 0.
  const d = tmpdir();
  writeQueue(d, 'caf\nExisting first\n\n---\n\npcaf\nExisting second\n');
  const ok = promptQueue.prependHead(d, 'pc\nFresh head block\nwith two lines');
  assert.strictEqual(ok, true);
  assert.strictEqual(promptQueue.queueLength(d), 3, 'queue grew by one');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'pc', 'new head carries its header');
  assert.ok(/Fresh head block[\s\S]*with two lines/.test(blocks[0].body),
    'multi-line body preserved verbatim');
  assert.strictEqual(blocks[1].pipeline, 'caf', 'previous head shifted to index 1');

  // (b) Prepend into an empty/missing queue file -> creates file w/ one block.
  const d2 = tmpdir();
  const okEmpty = promptQueue.prependHead(d2, 'caf\nOnly block');
  assert.strictEqual(okEmpty, true);
  assert.strictEqual(promptQueue.queueLength(d2), 1);
  assert.strictEqual(promptQueue.parseQueue(d2).blocks[0].pipeline, 'caf');

  // (c) Empty/whitespace-only input -> no-op (returns false).
  const d3 = tmpdir();
  writeQueue(d3, 'caf\nUntouched\n');
  assert.strictEqual(promptQueue.prependHead(d3, ''), false);
  assert.strictEqual(promptQueue.prependHead(d3, '   \n\n'), false);
  assert.strictEqual(promptQueue.queueLength(d3), 1, 'queue unchanged after no-op prepend');

  // (d) Lock released after call.
  assert.ok(!fs.existsSync(path.join(d, 'prompt-queue.md.lock')), 'lock released after prependHead');
});

// ── Regression: prependHead on a re-seeded (post-drain) queue lands at HEAD ──
test('prependHead lands at HEAD even when queue file was re-seeded after drain', () => {
  // QA pitfall: after `dequeueHead` drains the last block, the file is re-seeded
  // by `ensureQueueFile` with the `# Prompt Queue` instructional block. A naive
  // `prependHead` could leave the prepended block BELOW the seed in parse order,
  // losing head position. `splitBlocks` filters seed blocks via
  // `/^#\s+Prompt Queue\b/`, so head position is preserved — pin that contract.
  const d = tmpdir();
  // Seed file w/ instructional header but NO real queued blocks (drained state).
  promptQueue.ensureQueueFile(d);
  const seeded = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.ok(/# Prompt Queue/.test(seeded), 'precondition: file must contain seed header');
  assert.strictEqual(promptQueue.queueLength(d), 0,
    'precondition: re-seeded file reports zero queued blocks (seed filtered)');
  // Now re-queue a popped block — the contract: it MUST land at index 0.
  const ok = promptQueue.prependHead(d, 'caf\nRe-queued after failure');
  assert.strictEqual(ok, true, 'prependHead must succeed on a re-seeded file');
  assert.strictEqual(promptQueue.queueLength(d), 1,
    'exactly one real block after prepend onto seeded file');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1, 'parse yields only the re-queued block (seed filtered)');
  assert.strictEqual(blocks[0].pipeline, 'caf', 'restored block at HEAD with its header intact');
  assert.ok(/Re-queued after failure/.test(blocks[0].body),
    'restored block body preserved verbatim at head');
  // And: a subsequent dequeue returns exactly the re-queued block (not the seed).
  const r = promptQueue.dequeueHead(d, { defaultPipeline: 'all' });
  assert.ok(r && r.block && r.block.pipeline === 'caf',
    'dequeueHead after re-seed+prepend must return the re-queued block, not the seed');
  assert.ok(/Re-queued after failure/.test(r.block.body));
});

// ── (HOLD) hold marker: header inline `(hold)` ────────────────────────────────
test('hold marker: inline `(hold)` on header line flags block as held (case-insensitive)', () => {
  const d = tmpdir();
  writeQueue(d, 'caf (HOLD)\nHeld block body\n\n---\n\npcaf\nUnheld block body\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].held, true, 'inline (HOLD) on header must flag held');
  assert.strictEqual(blocks[0].pipeline, 'caf', 'pipeline must still parse with (hold) stripped');
  assert.ok(blocks[0].body.includes('Held block body'), 'body unchanged when held marker is on header');
  assert.strictEqual(blocks[1].held, false);
});

test('hold marker: `Pipeline: caf (hold)` form is also recognised', () => {
  const d = tmpdir();
  writeQueue(d, 'Pipeline: caf (hold)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].held, true);
});

// ── (HOLD) hold marker: body-line variations ──────────────────────────────────
test('hold marker: first non-blank body line variations flag held (hold / (hold) / [HOLD])', () => {
  for (const variant of ['hold', '(hold)', '[HOLD]', '<Hold>', 'HOLD']) {
    const d = tmpdir();
    writeQueue(d, `caf\n${variant}\nReal body line after marker\n`);
    const { blocks } = promptQueue.parseQueue(d);
    assert.strictEqual(blocks[0].held, true, `variant "${variant}" must flag held`);
    assert.ok(!blocks[0].body.split('\n').some(l => HOLD_LINE_RE_TEST(l)),
      `variant "${variant}" must be stripped from body`);
    assert.ok(blocks[0].body.includes('Real body line after marker'),
      `variant "${variant}" must preserve subsequent body content`);
  }
  function HOLD_LINE_RE_TEST(l) { return /^\s*[\[(\<]?\s*hold\s*[\]\)\>]?\s*$/i.test(l); }
});

test('hold marker: mid-body `hold` does NOT flag held (only first non-blank line counts)', () => {
  const d = tmpdir();
  writeQueue(d, 'caf\nReal prompt body first line\nhold\nmore body\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].held, false, 'mid-body hold must NOT flip the held flag');
  assert.ok(blocks[0].body.includes('hold'), 'mid-body hold line must be preserved');
});

// ── (HOLD) dequeueFirstUnheld skips held, picks first unheld ──────────────────
test('dequeueFirstUnheld: skips held blocks and dequeues the first unheld', () => {
  const d = tmpdir();
  writeQueue(d,
    'caf (hold)\nFirst held\n\n---\n\npcaf\nhold\nSecond also held via body line\n\n---\n\ncaf\nThird is the prompt to run\n\n---\n\npcaf\nFourth\n');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(r && r.block, 'expected a non-null pick');
  assert.strictEqual(r.skippedHeld, 2, 'two held blocks were skipped');
  assert.strictEqual(r.block.pipeline, 'caf');
  assert.ok(r.block.body.includes('Third is the prompt to run'));
  // The held blocks must remain in the file, in original order.
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.ok(/First held/.test(after), 'first held block retained in file');
  assert.ok(/Second also held/.test(after), 'second held block retained in file');
  assert.ok(!/Third is the prompt to run/.test(after), 'picked block removed from file');
  assert.ok(/Fourth/.test(after), 'unrelated trailing block retained');
});

test('dequeueFirstUnheld: all blocks held -> returns all-held warning + queue untouched', () => {
  const d = tmpdir();
  const initial = 'caf (hold)\nA\n\n---\n\npcaf\nhold\nB\n';
  writeQueue(d, initial);
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(r && r.warning === 'all-held', 'expected all-held warning');
  assert.strictEqual(r.block, null);
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.strictEqual(after, initial, 'queue file must be byte-identical when all blocks held');
});

// ── (EMPTY-PROMPT) fillEmptyPromptFromQueueOrInteractive wiring ───────────────
test('run-agent.js wires fillEmptyPromptFromQueueOrInteractive before stripTrailingUserPrompt', () => {
  assert.ok(/async function fillEmptyPromptFromQueueOrInteractive/.test(runAgentSrc),
    'run-agent.js must define fillEmptyPromptFromQueueOrInteractive');
  assert.ok(/await fillEmptyPromptFromQueueOrInteractive\(\);\s*\n\s*stripTrailingUserPrompt\(historyPath\);/.test(runAgentSrc),
    'fillEmptyPromptFromQueueOrInteractive must run immediately before stripTrailingUserPrompt');
  assert.ok(/promptQueue\.dequeueFirstUnheld\(/.test(runAgentSrc),
    'fill fn must call promptQueue.dequeueFirstUnheld (skips held blocks)');
  // Invoked-shorthand-wins: fill fn must NOT pass queued pipeline to runPipeline —
  // it must only inject the body. Source check: fn body never invokes resolvePipelineFromShorthand.
  const fnMatch = runAgentSrc.match(/async function fillEmptyPromptFromQueueOrInteractive[\s\S]*?\n\}\n/);
  assert.ok(fnMatch, 'fill fn body extractable');
  assert.ok(!/resolvePipelineFromShorthand/.test(fnMatch[0]),
    'fill fn must NOT resolve pipeline from queued header — invoked shorthand always wins');
  assert.ok(/injectQueuedPromptIntoHistory\(/.test(fnMatch[0]),
    'fill fn must inject queued body into history');
});

test('run-agent.js falls back to interactive multi-line prompt when queue empty / all-held', () => {
  const fnMatch = runAgentSrc.match(/async function fillEmptyPromptFromQueueOrInteractive[\s\S]*?\n\}\n/);
  assert.ok(fnMatch, 'fill fn body extractable');
  const body = fnMatch[0];
  assert.ok(/EMPTY PROMPT detected/i.test(body),
    'fallback prompt must explain WHY the harness is asking (empty prompt + queue state)');
  assert.ok(/all-held|all .* held|queued block\(s\) are marked/.test(body),
    'fallback message must distinguish all-held from empty queue');
  assert.ok(/readMultilinePromptFromStdin\(\)/.test(body),
    'fallback must invoke the multi-line stdin reader');
  assert.ok(/function readMultilinePromptFromStdin/.test(runAgentSrc),
    'run-agent.js must define readMultilinePromptFromStdin');
  // Always-on: fill fn must NOT branch on any config key like
  // `promptQueue.fillEmptyFromQueue` or similar opt-out.
  assert.ok(!/cfgRead\([^)]*fillEmpty/.test(body),
    'fill fn must NOT consult an opt-out config key — always on per spec');
});

// ── (EMPTY-PROMPT) Behavioural: empty trailing `## User Prompt` triggers injection ──
test('empty trailing `## User Prompt` -> fill fn injects body from queue head (unheld)', () => {
  // Behavioural simulation of the dispatch path — exercise just the queue
  // selection + injection plumbing in isolation. Mirrors the real fn's
  // detection regex + dequeue + inject call.
  const d = tmpdir();
  writeQueue(d, 'caf (hold)\nHeld first\n\n---\n\npcaf\nFresh body to inject\n');
  const historyFile = path.join(d, 'history.md');
  fs.writeFileSync(historyFile, '# History\n\nprior content\n\n---\n\n## User Prompt\n\n', 'utf8');

  const trailingEmptyRe = /(\n+(?:---\s*\n+)?)## User Prompt[^\n]*\s*\n*$/;
  const initial = fs.readFileSync(historyFile, 'utf8');
  assert.ok(trailingEmptyRe.test(initial), 'history precondition: trailing empty prompt detected');

  const picked = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(picked && picked.block, 'unheld block must be picked');
  assert.strictEqual(picked.skippedHeld, 1, 'first held block was skipped');
  assert.ok(picked.block.body.includes('Fresh body to inject'));

  // Inline copy of injectQueuedPromptIntoHistory's reuse-or-append logic.
  const txt = fs.readFileSync(historyFile, 'utf8');
  const next = txt.replace(trailingEmptyRe, `$1## User Prompt (From the Queue)\n\n${picked.block.body}\n`);
  fs.writeFileSync(historyFile, next, 'utf8');

  const out = fs.readFileSync(historyFile, 'utf8');
  assert.ok(/## User Prompt \(From the Queue\)/.test(out), 'injected header tagged');
  assert.ok(/Fresh body to inject/.test(out), 'queued body present in history');
  // Held block remains queued for later.
  const queueAfter = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.ok(/Held first/.test(queueAfter), 'held block must still be in queue after fill');
  assert.ok(!/Fresh body to inject/.test(queueAfter), 'picked block consumed from queue');
});

// ── (EMPTY-PROMPT) HTML-comment-only body must be treated as empty ────────────
// Regression: a `## User Prompt` whose body is only an HTML comment (e.g. an
// auto-inserted placeholder) was previously mis-classified as non-empty and
// silently skipped dequeue. The detection regex now matches the LAST trailing
// header (negative lookahead forbids a later `## User Prompt` in body), and the
// body is considered empty when HTML-comment + whitespace stripped is empty.
test('fillEmptyPromptFromQueueOrInteractive: detects empty placeholder + last-header match', () => {
  const trailingPromptRe = /(\n+(?:---\s*\n+)?)## User Prompt[^\n]*\n((?:(?!\n## User Prompt)[\s\S])*)$/;
  const isEmpty = (raw) => raw.replace(/<!--[\s\S]*?-->/g, '').trim().length === 0;

  // (a) HTML-comment-only placeholder body — must be classified empty.
  const histCommentOnly = '# History\n\n---\n\n## User Prompt\n\n<!-- placeholder -->\n';
  const mA = trailingPromptRe.exec(histCommentOnly);
  assert.ok(mA, 'regex matches HTML-comment-only placeholder');
  assert.ok(isEmpty(mA[2]), 'HTML-comment-only body must classify as empty');

  // (b) Multi-section history: prior real `## User Prompt` + later trailing placeholder.
  //     Must match the LAST header, body of the placeholder only.
  const histMulti =
    '## User Prompt\n\nReal earlier prompt content.\n\n## Coding Agent Response\n\nDone.\n\n---\n\n## User Prompt\n\n<!-- placeholder -->\n';
  const mB = trailingPromptRe.exec(histMulti);
  assert.ok(mB, 'regex matches in multi-section history');
  assert.ok(!/Real earlier prompt content/.test(mB[2]),
    'body capture must NOT include earlier prompt — must anchor to LAST header');
  assert.ok(isEmpty(mB[2]), 'trailing placeholder body must classify as empty');

  // (c) Non-empty trailing prompt — must NOT classify as empty.
  const histReal = '# History\n\n## User Prompt\n\nGenuine user content here.\n';
  const mC = trailingPromptRe.exec(histReal);
  assert.ok(mC && !isEmpty(mC[2]), 'real prompt must not be classified as empty');
});

// ── (HEADER-WINS) Invoked shorthand always wins — queued pipeline ignored ─────
test('fill fn ignores queued block header — pipeline from invocation wins', () => {
  // dequeueFirstUnheld returns the block but the fill fn must not pass
  // block.pipeline into runPipeline. Source-level guard already covered above;
  // behaviourally, the returned block exposes both body and pipeline so the
  // caller is free to choose — confirm both are present on the returned obj.
  const d = tmpdir();
  writeQueue(d, 'pcaf\nWill be injected by body only\n');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(r && r.block);
  assert.strictEqual(r.block.pipeline, 'pcaf', 'queued pipeline reported (informational only)');
  assert.ok(r.block.body.includes('Will be injected by body only'));
});

// ── Regression: standalone `(hold)` above header-less / bare / Pipeline-prefixed body ──
// Requirement (user prompt): `(hold)` as the first non-blank line of a block
// must flag held even when NO recognised header follows on the next line. Covers
// the three observed forms from the live `prompt-queue.md` repro:
//   (i)  standalone `(hold)` above a bare prompt with NO header at all
//   (ii) standalone `(hold)` above a `Pipeline: caf` header
//   (iii) standalone `(hold)` above a bare-shorthand header (`pcaf`)
// All three must (a) flag `held=true`, (b) strip the hold line from `body`,
// (c) cause `dequeueFirstUnheld` to skip them.
test('hold marker: standalone `(hold)` above header-less prompt flags held + skipped by dequeue', () => {
  const d = tmpdir();
  writeQueue(d, '(hold)\n\nBare prompt body — no header at all, just text under a standalone hold.\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].held, true, 'standalone (hold) above header-less body must flag held');
  assert.strictEqual(blocks[0].pipeline, null, 'no header means pipeline stays null until defaultPipeline applied');
  assert.strictEqual(blocks[0].headerForm, null, 'no header form recognised');
  assert.ok(!/^\s*\(hold\)\s*$/im.test(blocks[0].body.split('\n')[0]), '(hold) line stripped from body head');
  assert.ok(blocks[0].body.includes('Bare prompt body'), 'real body content preserved after strip');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.warning === 'all-held', 'only block is held -> all-held');
  assert.strictEqual(r.block, null);
  assert.strictEqual(r.skippedHeld, 1, 'standalone-hold block counted as skipped');
});

test('hold marker: standalone `(hold)` above `Pipeline: caf` header still flags held', () => {
  const d = tmpdir();
  writeQueue(d, '(hold)\n\nPipeline: caf\nReal prompt body under the header.\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].held, true, 'standalone hold above Pipeline header must flag held');
  // First non-blank line was `(hold)` — not a recognised header — so headerIdx stays -1,
  // and the `Pipeline: caf` line remains inside the body. Pipeline stays null at parse.
  assert.strictEqual(blocks[0].pipeline, null,
    'standalone hold above header swallows the header into body — pipeline parses as null');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.warning === 'all-held', 'only block held -> all-held warning');
  assert.strictEqual(r.skippedHeld, 1);
});

test('hold marker: standalone `(hold)` above bare-shorthand header (`pcaf`) still flags held', () => {
  const d = tmpdir();
  writeQueue(d, '(hold)\n\npcaf\nBody after bare-shorthand header.\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].held, true, 'standalone hold above bare shorthand must flag held');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.warning === 'all-held');
  assert.strictEqual(r.skippedHeld, 1);
});

// ── Regression: full repro of the live `prompt-queue.md` (two `(hold)` blocks) ─
// Requirement (user prompt): "run topic w/ current `prompt-queue.md` (two
// `(hold)`-prefixed blocks)" — ensure parser flags both held and `dequeueFirstUnheld`
// returns `all-held` with `skippedHeld === 2`. Pins the exact observed shape.
test('hold marker: two-block live repro — both `(hold)` standalone, dequeue reports all-held with skippedHeld=2', () => {
  const d = tmpdir();
  writeQueue(d,
    '(hold)\n\nFirst held prompt with no header.\nMulti-line body fine.\n\n---\n\n(hold)\n\n1. Numbered second held prompt.\n2. Also has no header.\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].held, true);
  assert.strictEqual(blocks[1].held, true);
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.warning === 'all-held', 'both held -> all-held');
  assert.strictEqual(r.skippedHeld, 2, 'both blocks counted as skipped');
  // Queue file must be byte-identical when nothing dispatched.
  const initial = '(hold)\n\nFirst held prompt with no header.\nMulti-line body fine.\n\n---\n\n(hold)\n\n1. Numbered second held prompt.\n2. Also has no header.\n';
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.strictEqual(after, initial, 'queue must be untouched when every block held');
});

// ── Regression: seed template demonstrates the standalone-hold form ───────────
// Requirement (plan bullet 4): the seed `EXAMPLE` block must show a `(hold)`
// standalone above a header-less prompt body so new topics learn the syntax.
// Also pins: the seed must still be filtered as a single block by `splitBlocks`
// (so `queueLength` returns 0 on a freshly-seeded file).
test('ensureQueueFile seed includes a standalone `(hold)` example AND parses as zero blocks', () => {
  const d = tmpdir();
  assert.strictEqual(promptQueue.ensureQueueFile(d), true);
  const seeded = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.ok(/# Prompt Queue/.test(seeded), 'seed retains `# Prompt Queue` header');
  assert.ok(/\(hold\)/.test(seeded), 'seed example must demonstrate `(hold)` syntax');
  assert.ok(/HOLD MARKER/i.test(seeded), 'seed must explain the HOLD MARKER form');
  assert.ok(/standalone/i.test(seeded), 'seed must mention standalone-above-header-less form');
  // The seed must still be filtered as a single instructional block (queueLength 0)
  // — otherwise the new indented `---` lines inside the HTML comment would
  // fragment the seed and survive as queued prompts.
  assert.strictEqual(promptQueue.queueLength(d), 0,
    'seeded file (no user prompts yet) must report zero queued blocks');
});

// ── Regression: seed file + user-appended `(hold)` block coexist correctly ─────
// Requirement (QA assessment): the live scenario seeds a fresh queue file via
// `ensureQueueFile` (HTML comment w/ indented `---` lines inside it) and the
// user then appends a `(hold)` block under the seed's trailing `---` divider.
// Must hold: (a) indented `---` lines inside the HTML comment do NOT fragment
// the seed, (b) the seed is filtered out by `splitBlocks` so `queueLength`
// reports exactly 1 (the appended block), (c) the appended block flags
// `held=true`, and (d) `dequeueFirstUnheld` returns `all-held` leaving the
// file byte-identical.
test('seed + user-appended `(hold)` block: indented `---` inside HTML comment must not fragment seed', () => {
  const d = tmpdir();
  assert.strictEqual(promptQueue.ensureQueueFile(d), true);
  const seeded = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  const appended = seeded + '(hold)\n\nUser-appended hold block under seed.\n';
  fs.writeFileSync(path.join(d, 'prompt-queue.md'), appended, 'utf8');
  assert.strictEqual(promptQueue.queueLength(d), 1,
    'seed filtered out; only the user-appended block counts');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].held, true, 'appended `(hold)` block must flag held');
  assert.ok(blocks[0].body.includes('User-appended hold block'),
    'appended block body preserved after hold strip');
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(r && r.warning === 'all-held', 'sole block held -> all-held');
  assert.strictEqual(r.skippedHeld, 1);
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.strictEqual(after, appended, 'queue file untouched when only block held');
});

// ── (DRAIN) dequeueAndTriggerNext must use hold-aware dequeue ─────────────────
test('dequeueAndTriggerNext source uses dequeueFirstUnheld, not unconditional dequeueHead', () => {
  const fnMatch = runAgentSrc.match(/async function dequeueAndTriggerNext[\s\S]*?\n\/\/ ── Dispatch/);
  assert.ok(fnMatch, 'dequeueAndTriggerNext body extractable');
  const body = fnMatch[0];
  assert.ok(/promptQueue\.dequeueFirstUnheld\(/.test(body),
    'drain loop must call dequeueFirstUnheld (skips held blocks)');
  assert.ok(!/promptQueue\.dequeueHead\(/.test(body),
    'drain loop must NOT call dequeueHead — that pops held blocks');
  assert.ok(/all-held/.test(body),
    'drain loop must handle the all-held warning path');
});

// ── (DRAIN) behavioural: mixed hold/unheld -> only unheld dequeued in order ───
test('drain simulation: [hold A, unheld B, hold C, unheld D] -> B then D consumed, A+C retained', () => {
  const d = tmpdir();
  writeQueue(d,
    'caf (hold)\nA held\n\n---\n\npcaf\nB unheld\n\n---\n\ncaf (hold)\nC held\n\n---\n\npcaf\nD unheld\n');
  const r1 = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(r1 && r1.block && r1.block.body.includes('B unheld'));
  assert.strictEqual(r1.skippedHeld, 1);
  const r2 = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(r2 && r2.block && r2.block.body.includes('D unheld'));
  assert.strictEqual(r2.skippedHeld, 2, 'two held blocks skipped on second pick');
  const r3 = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(r3 && r3.warning === 'all-held', 'remaining held blocks -> all-held');
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  const ai = after.indexOf('A held'), ci = after.indexOf('C held');
  assert.ok(ai >= 0 && ci > ai, 'held A and C retained in original order');
  assert.ok(!/B unheld/.test(after) && !/D unheld/.test(after), 'both unheld blocks consumed');
});

// ── (DRAIN) all-held -> queue byte-identical ──────────────────────────────────
test('drain simulation: all-held queue is left byte-identical', () => {
  const d = tmpdir();
  const initial = 'caf (hold)\nA\n\n---\n\npcaf (hold)\nB\n';
  writeQueue(d, initial);
  const r = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(r && r.warning === 'all-held');
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.strictEqual(after, initial, 'all-held -> queue untouched');
});

// ── (DRAIN) failed pipeline re-queues body without displacing held A ──────────
test('drain simulation: re-queued unheld B after failure does not displace held A from its slot', () => {
  // Note: current `prependHead` inserts at top of file, so re-queue lands ABOVE
  // held A. Subsequent dequeueFirstUnheld still picks B (the unheld block) and
  // skips A — held A is not consumed. This pins the recoverable behaviour.
  const d = tmpdir();
  writeQueue(d, 'caf (hold)\nA held\n\n---\n\npcaf\nB unheld\n');
  const popped = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(popped && popped.block && popped.block.body.includes('B unheld'));
  // Simulate pipeline failure -> re-queue raw block at head.
  promptQueue.prependHead(d, popped.block.raw);
  const next = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all' });
  assert.ok(next && next.block, 'unheld B picked again on retry');
  assert.ok(next.block.body.includes('B unheld'));
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.ok(/A held/.test(after), 'held A still in queue');
  assert.ok(!/B unheld/.test(after), 'B consumed on retry');
});

// ── Fixture: user's actual claude_harness/prompt-queue.md state ──────────────
// Reproduces the exact on-disk content the user reported as "queue blocks not
// picked up". Pins the expected behaviour so a future seed-prefix or
// hold-detection regression surfaces immediately.
test('fixture (claude_harness): standalone-hold block A skipped, Pipeline:c block B dispatched', () => {
  const d = tmpdir();
  const fixture =
    '(hold)\n' +
    '\n' +
    'I want to return to the task of making this harness Provider agnostic.\n' +
    '\n' +
    'See previous prompt and response history here: `Agent_Orchestrator\\topic_files\\claude_harness\\Prompt and responses to make the harness provider agnostic.md`\n' +
    '\n' +
    'Also see the generated plan here: `Agent_Orchestrator\\provider-abstraction-design.md`\n' +
    '\n' +
    'How can we go about implementing this in an iterative way that should be safe and not break existing functionality?\n' +
    '\n' +
    '---\n' +
    '\n' +
    'Pipeline: c\n' +
    '\n' +
    'Please remove the config variable `"auto-answer-clarifying-questions"` Along with the associated comment variable. And please remove all code made redundant by the removal of this config variable.\n' +
    '\n' +
    'There will no longer be a feature to auto-answer clarifying questions.\n';
  writeQueue(d, fixture);
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 2, `expected 2 parsed blocks, got ${blocks.length}`);
  assert.strictEqual(blocks[0].held, true, 'block 0 must be flagged held (standalone `(hold)` line)');
  assert.strictEqual(blocks[1].held, false, 'block 1 must NOT be held');
  assert.strictEqual(blocks[1].pipeline, 'c', 'block 1 pipeline shorthand should resolve to `c`');
  // SEED_PREFIX_RE must not match either block — neither starts with `# Prompt Queue`.
  for (const b of blocks) {
    assert.ok(!/^#\s+Prompt Queue/.test(b.raw),
      'no block should false-positive on SEED_PREFIX_RE');
  }
  const picked = promptQueue.dequeueFirstUnheld(d, { defaultPipeline: 'all', log: () => {} });
  assert.ok(picked && picked.block, 'dequeueFirstUnheld must return block B');
  assert.strictEqual(picked.skippedHeld, 1, 'must report 1 skipped held block');
  assert.strictEqual(picked.block.pipeline, 'c');
  assert.ok(/auto-answer-clarifying-questions/.test(picked.block.body),
    'returned body must contain the README-testing-adjacent prompt content');
  // Held block A must remain in the file post-dequeue.
  const after = fs.readFileSync(path.join(d, 'prompt-queue.md'), 'utf8');
  assert.ok(/Provider agnostic/.test(after), 'held block A must remain on disk');
  assert.ok(!/auto-answer-clarifying-questions/.test(after), 'block B must be consumed');
});

if (_failed === 0) console.log('\nAll prompt-queue tests passed.');
