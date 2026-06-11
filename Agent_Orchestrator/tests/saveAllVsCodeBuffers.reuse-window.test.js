#!/usr/bin/env node
'use strict';

// Editor-agnostic buffer-flush: the harness no longer auto-injects --reuse-window.
// The user supplies the full recipe via `editor-save-all-command` and it is passed
// to spawnSync verbatim. This test asserts:
//   1. The default config string keeps `--reuse-window` so existing VS Code users
//      don't suddenly start spawning new windows on upgrade.
//   2. No auto-injection logic remains in `flushEditorBuffers` (formerly
//      `saveAllVsCodeBuffers`) — passing the cmd through verbatim is what makes
//      the abstraction editor-agnostic.
//   3. Both spawnSync calls (initial + Windows `.cmd` retry) still share the same
//      `rest` args array, so any flags configured by the user reach the retry.
//
//   node Agent_Orchestrator/tests/saveAllVsCodeBuffers.reuse-window.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const GLOBAL = path.join(HARNESS, 'global-config.json');
const src = fs.readFileSync(RUN_AGENT, 'utf8');
const globalCfg = configUtils.loadConfig(GLOBAL);

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('default editor-save-all-command includes --reuse-window (VS Code recipe)', () => {
  assert.strictEqual(
    globalCfg['editor-save-all-command'],
    'code --reuse-window --command workbench.action.files.saveAll',
    'default global-config should keep --reuse-window in the default VS Code recipe'
  );
});

test('flushEditorBuffers does NOT auto-inject --reuse-window (editor-agnostic verbatim pass-through)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'flushEditorBuffers block found');
  assert.ok(
    !/rest\.unshift\(['"]--reuse-window['"]\)/.test(fn[0]),
    'auto-injection of --reuse-window must be removed (editor-agnostic pass-through)'
  );
  assert.ok(
    !/rest\.includes\(['"]--reuse-window['"]\)/.test(fn[0]),
    'guard for --reuse-window must be removed'
  );
});

test('both spawnSync calls share the same rest array (user flags propagate to retry)', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'flushEditorBuffers block found');
  const body = fn[0];
  const initial = body.match(/let r = spawnSync\(bin, (\w+), \{[^}]*shell:\s*false/);
  const retry = body.match(/r = spawnSync\(retryBin, (\w+), \{[^}]*shell:\s*true/);
  assert.ok(initial && retry, 'both spawnSync calls present');
  assert.strictEqual(initial[1], retry[1], 'initial + retry must pass the same args variable');
  assert.strictEqual(initial[1], 'rest', 'spawnSync args var must be `rest`');
});

test('back-compat alias saveAllVsCodeBuffers still exists and points to flushEditorBuffers', () => {
  assert.ok(
    /const\s+saveAllVsCodeBuffers\s*=\s*flushEditorBuffers/.test(src),
    'expected `const saveAllVsCodeBuffers = flushEditorBuffers;` alias for back-compat'
  );
});

test('user-supplied verbatim cmd reaches spawn args without modification', () => {
  // Behavioral replica of the tokenize-then-spawn path. The harness must pass
  // through `--reuse-window` (or NOT) exactly as the user configured it.
  const calls = [];
  const fakeSpawnSync = (bin, args) => {
    calls.push({ bin, args: args.slice() });
    return { status: 0, error: null };
  };
  function flushReplica(cmd) {
    const parts = cmd.match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
    const argv = parts.map(p => p.replace(/^["']|["']$/g, ''));
    const [bin, ...rest] = argv;
    fakeSpawnSync(bin, rest, { shell: false });
  }
  flushReplica('subl --command save_all');
  assert.strictEqual(calls[0].bin, 'subl');
  assert.deepStrictEqual(calls[0].args, ['--command', 'save_all'],
    'Sublime recipe must pass through verbatim — no --reuse-window injection');

  calls.length = 0;
  flushReplica('cursor --reuse-window --command workbench.action.files.saveAll');
  assert.strictEqual(calls[0].bin, 'cursor');
  assert.ok(calls[0].args.includes('--reuse-window'),
    'user-configured --reuse-window must reach spawn args');
});
