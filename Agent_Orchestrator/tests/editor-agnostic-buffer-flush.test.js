#!/usr/bin/env node
'use strict';

// Regression tests for the editor-agnostic buffer-flush refactor:
//   - Config keys `editor-save-all-command` / `editor-save-flush-ms` (new) override
//     legacy `vscode-save-all-command` / `vscode-save-flush-ms` (still honored).
//   - Empty config string -> no spawn at all (pure-CLI users with no editor open).
//   - Function renamed `saveAllVsCodeBuffers` -> `flushEditorBuffers` with back-compat alias.
//   - No hard-coded `--reuse-window` injection (would only fit VS Code / Cursor).
//   - Windows `.cmd` retry gated to `code`/`cursor` bins so unrelated editors don't
//     get a bogus `.cmd` suffix masking the real error.
//   - README + global-config.json document the new keys and at least one non-VS-Code recipe.
//
//   node Agent_Orchestrator/tests/editor-agnostic-buffer-flush.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const GLOBAL = path.join(HARNESS, 'global-config.json');
const README = path.join(HARNESS, 'README.md');
const src = fs.readFileSync(RUN_AGENT, 'utf8');
const readmeSrc = fs.readFileSync(README, 'utf8');
const globalCfg = configUtils.loadConfig(GLOBAL);
const globalCfgRaw = fs.readFileSync(GLOBAL, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── (1) Function renamed + alias preserved ────────────────────────────────────
test('(1) source declares function flushEditorBuffers(...)', () => {
  // Signature now accepts opts (e.g. {force}) for the per-run throttle bypass.
  assert.ok(/function\s+flushEditorBuffers\s*\([^)]*\)/.test(src),
    'expected `function flushEditorBuffers(...)` in run-agent.js');
});

test('(1) back-compat alias `const saveAllVsCodeBuffers = flushEditorBuffers` present', () => {
  assert.ok(/const\s+saveAllVsCodeBuffers\s*=\s*flushEditorBuffers/.test(src),
    'alias must remain so existing call sites + tests keep working');
});

// ── (2) Config keys ───────────────────────────────────────────────────────────
test('(2) global-config.json declares editor-save-all-command (new key)', () => {
  assert.ok('editor-save-all-command' in globalCfg, 'new key must exist');
  assert.ok(typeof globalCfg['editor-save-all-command'] === 'string');
});

test('(2) global-config.json declares editor-save-flush-ms (new key)', () => {
  assert.ok('editor-save-flush-ms' in globalCfg, 'new flush-ms key must exist');
  assert.strictEqual(typeof globalCfg['editor-save-flush-ms'], 'number');
});

test('(2) cfgRead reads new editor-save-all-command key from topic override', () => {
  const topic = { 'editor-save-all-command': 'subl --command save_all' };
  assert.strictEqual(
    configUtils.cfgRead(topic, globalCfg, 'editor-save-all-command', ''),
    'subl --command save_all',
    'topic override of new key must win'
  );
});

test('(2) legacy `vscode-save-all-command` still readable via cfgRead alias path', () => {
  // Legacy alias remains for one-release backward compat: users with old
  // topic-config.json still get their buffers flushed.
  const legacyTopic = { 'vscode-save-all-command': 'code --command workbench.action.files.saveAll' };
  assert.strictEqual(
    configUtils.cfgRead(legacyTopic, globalCfg, 'vscode-save-all-command', ''),
    'code --command workbench.action.files.saveAll',
    'legacy key must still be readable for back-compat'
  );
});

test('(2) flushEditorBuffers source reads new key first, falls back to legacy', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  const body = fn[0];
  // Either nullish-coalesce or || cascade, but new key must appear BEFORE legacy.
  const newIdx = body.indexOf("'editor-save-all-command'");
  const legacyIdx = body.indexOf("'vscode-save-all-command'");
  assert.ok(newIdx > 0, 'new key must be referenced in flushEditorBuffers');
  assert.ok(legacyIdx > 0, 'legacy key must still be referenced as fallback');
  assert.ok(newIdx < legacyIdx, 'new key must be read BEFORE legacy fallback');

  const newMsIdx = body.indexOf("'editor-save-flush-ms'");
  const legacyMsIdx = body.indexOf("'vscode-save-flush-ms'");
  assert.ok(newMsIdx > 0 && legacyMsIdx > 0, 'both flush-ms keys referenced');
  assert.ok(newMsIdx < legacyMsIdx, 'new flush-ms key read before legacy');
});

// ── (3) Editor-agnostic verbatim pass-through (no --reuse-window injection) ───
test('(3) flushEditorBuffers does NOT inject --reuse-window (editor-agnostic)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  assert.ok(!/rest\.unshift\(['"]--reuse-window['"]\)/.test(fn[0]),
    'hard-coded --reuse-window injection breaks non-VS-Code editors');
});

// ── (4) Empty config = no spawn (pure-CLI users supported) ────────────────────
test('(4) empty cmd config -> early return (pure-CLI / no-editor support)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  // Early-return guard: `if (!cmd) return;` must come before any spawn.
  const guardIdx = fn[0].search(/if\s*\(\s*!\s*cmd\s*\)\s*return/);
  const spawnIdx = fn[0].indexOf('spawnSync(');
  assert.ok(guardIdx > 0, 'expected `if (!cmd) return;` early-return guard');
  assert.ok(guardIdx < spawnIdx, 'early-return must precede spawnSync');
});

// ── (5) Windows .cmd retry gated to code-like bins ────────────────────────────
test('(5) Windows .cmd retry gated to code/cursor bins (no bogus suffix for other editors)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  // Gate must reference both the win32 check AND a bin-name allowlist.
  assert.ok(/process\.platform\s*===\s*'win32'/.test(fn[0]),
    'retry must be gated to win32');
  assert.ok(/code|cursor/.test(fn[0]),
    'retry gate must include `code` (VS Code) and/or `cursor` (Cursor)');
  // The gate must guard the retry spawn, not the initial.
  const retryMatch = fn[0].match(/if\s*\([\s\S]*?isCodeLikeBin[\s\S]*?\)\s*\{[\s\S]*?retryBin/);
  assert.ok(retryMatch, 'retry block must be guarded by isCodeLikeBin (or equivalent)');
});

// ── (6) Documentation + non-VS-Code recipe ────────────────────────────────────
test('(6) README documents `editor-save-all-command` (new key) and at least one non-VS-Code recipe', () => {
  assert.ok(/`editor-save-all-command`/.test(readmeSrc),
    'README must document new editor-agnostic key');
  assert.ok(/`editor-save-flush-ms`/.test(readmeSrc),
    'README must document new flush-ms key');
  assert.ok(/cursor|sublime|subl|vim|jetbrains|idea/i.test(readmeSrc),
    'README must list at least one non-VS-Code recipe');
  // Legacy key must be mentioned as deprecated/aliased so users find the migration path.
  assert.ok(/vscode-save-all-command/.test(readmeSrc),
    'README must mention legacy alias for migration');
});

test('(6) global-config.json doc-comment mentions legacy alias is honored', () => {
  assert.ok(/"\/\/ editor-save-all-command"/.test(globalCfgRaw),
    'global-config must have doc-comment for new key');
  const docBlock = globalCfgRaw.split('"// editor-save-all-command"')[1] || '';
  assert.ok(/vscode-save-all-command/i.test(docBlock.slice(0, 800)),
    'doc-comment should mention legacy alias for users migrating');
});

// ── (7) No CLI-blocker for headless / no-editor users ────────────────────────
// ── (8) Deleted-key fallback matches documented default (no silent no-op) ─────
test('(8) when BOTH keys absent, source falls back to documented default (not "")', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  const body = fn[0];
  // Documented default string must appear literally in the source.
  assert.ok(/code --reuse-window --command workbench\.action\.files\.saveAll/.test(body),
    'in-code default must match README/global-config to prevent silent no-op when keys deleted');
  // The fallback chain must distinguish absent (null) from explicit-disable ("").
  assert.ok(/!=\s*null/.test(body) || /!==\s*null/.test(body),
    'fallback must use null-check so explicit "" still disables');
});

test('(8) explicit empty string in topic config still disables (user opt-out respected)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  // The early-return `if (!cmd) return;` is what enforces the "" -> disable behavior
  // after the resolution chain. Together with the null-vs-"" distinction it gives:
  //   key absent  -> default cmd
  //   key === ""  -> resolved = "" -> trim() = "" -> !cmd -> return (disabled)
  //   key set     -> resolved = key
  assert.ok(/if\s*\(\s*!\s*cmd\s*\)\s*return/.test(fn[0]),
    'empty-string opt-out path requires `if (!cmd) return` guard after resolution');
});

// ── (9) Windows .cmd retry covers code-insiders ───────────────────────────────
test('(9) .cmd retry regex includes `code-insiders` (Windows VS Code Insiders bin)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  const m = fn[0].match(/\/\^\([^)]+\)[^/]*\/i\.test\(bin\)/);
  assert.ok(m, 'regex literal that tests bin must be present');
  assert.ok(/code-insiders|code\(-insiders\)\?/.test(m[0]),
    `retry regex must cover code-insiders.cmd; got: ${m[0]}`);
});

// ── (10) cfgRead returns explicit fallback (not undefined) when key absent ────
test('(10) cfgRead returns supplied fallback (not undefined) for absent keys', () => {
  // Guarantees the `?? legacy ?? default` chain in flushEditorBuffers behaves.
  const r1 = configUtils.cfgRead({}, {}, 'definitely-not-a-real-key', null);
  assert.strictEqual(r1, null, 'absent key -> supplied fallback (null), NOT undefined');
  const r2 = configUtils.cfgRead({}, {}, 'definitely-not-a-real-key', 'sentinel');
  assert.strictEqual(r2, 'sentinel', 'absent key -> supplied fallback string');
  // Explicit null in config also returns fallback (null != null check in cfgRead).
  const r3 = configUtils.cfgRead({ 'editor-save-all-command': null }, {}, 'editor-save-all-command', 'fb');
  assert.strictEqual(r3, 'fb', 'config value null -> fallback (null-skip in cfgRead)');
});

// ── (11) Legacy comment misattribution corrected (Claude Code CLI, not VS Code) ─
test('(11) projects-dir cleanup comment attributes session JSONL to Claude Code CLI', () => {
  // The comment at the cleanupHarnessSessionFile site previously claimed the
  // VS Code extension reads `~/.claude/projects/...`; truth is the Claude Code
  // CLI writes it and any wrapper reads it. Comment must reflect editor-agnostic reality.
  const cleanupBlock = src.match(/function cleanupHarnessSessionFile[\s\S]{0,800}/);
  assert.ok(cleanupBlock, 'cleanup function found');
  // Comment immediately above must mention "Claude Code CLI" as the writer.
  const aboveIdx = src.indexOf('function cleanupHarnessSessionFile');
  const above = src.slice(Math.max(0, aboveIdx - 800), aboveIdx);
  assert.ok(/Claude Code CLI/.test(above),
    'comment must attribute session-file writes to the Claude Code CLI (editor-agnostic)');
});

test('(7) call sites still invoke through alias (no API break for in-tree callers)', () => {
  // The harness calls flushEditorBuffers() via the alias from snapshotHistorySize +
  // promptForUserReply + handleClarifyingQuestionsIfAny + dispatch entry. Those
  // call sites must keep working because every Enter-twice cycle depends on the
  // flush. Match BOTH `saveAllVsCodeBuffers()` and `saveAllVsCodeBuffers({...})`
  // -> user-interaction boundaries now pass `{force: true}` to bypass the
  // per-run throttle that suppresses phase-boundary taskbar flashes.
  const callCount = (src.match(/saveAllVsCodeBuffers\(\s*(?:\{[^}]*\})?\s*\)/g) || []).length;
  assert.ok(callCount >= 3,
    `expected ≥3 call sites for saveAllVsCodeBuffers alias, found ${callCount}`);
});
