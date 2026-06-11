#!/usr/bin/env node
'use strict';

// Regression: saveAllVsCodeBuffers must pass `windowsHide: true` to BOTH
// spawnSync calls so the transient cmd console used to invoke `code.cmd`
// does not register in the Windows taskbar and cause the VS Code icon to
// flash on each pipeline run.
//   node Agent_Orchestrator/tests/saveAllVsCodeBuffers.windowsHide.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('initial spawnSync passes windowsHide: true', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  const initial = fn[0].match(/let r = spawnSync\(bin, rest, \{([^}]*)\}\)/);
  assert.ok(initial, 'initial spawnSync call found');
  assert.ok(/windowsHide:\s*true/.test(initial[1]), 'initial spawnSync opts must include windowsHide: true');
});

test('Windows .cmd retry spawnSync passes windowsHide: true', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  const retry = fn[0].match(/r = spawnSync\(retryBin, rest, \{([^}]*)\}\)/);
  assert.ok(retry, 'retry spawnSync call found');
  assert.ok(/windowsHide:\s*true/.test(retry[1]), 'retry spawnSync opts must include windowsHide: true');
});

test('both spawnSync calls in saveAllVsCodeBuffers have windowsHide: true', () => {
  const fn = src.match(/function flushEditorBuffers\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(fn, 'function block found');
  const spawns = fn[0].match(/spawnSync\([^)]*\)/g) || [];
  assert.strictEqual(spawns.length, 2, 'expected exactly 2 spawnSync calls');
  for (const s of spawns) {
    assert.ok(/windowsHide:\s*true/.test(s), `spawnSync missing windowsHide: true -> ${s}`);
  }
});
