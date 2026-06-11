#!/usr/bin/env node
'use strict';

/**
 * Tests confirming compress-memory.js routes through getProvider() rather than
 * calling spawnSync('claude', ...) directly.
 *
 * (CM1) compress-memory.js source imports getProvider from registry, not spawnSync('claude')
 * (CM2) callClaude is async (uses await provider.spawn, not spawnSync)
 * (CM3) compress-memory.js does not contain any spawnSync('claude') call
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(HARNESS, 'src', 'compress-memory.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('(CM1) compress-memory.js imports getProvider from registry', () => {
  assert.ok(
    SRC.includes("require('./lib/providers/registry')"),
    'compress-memory.js must require registry'
  );
  assert.ok(SRC.includes('getProvider'), 'compress-memory.js must reference getProvider');
});

test('(CM2) callClaude is declared async and awaits provider.spawn', () => {
  assert.ok(/async function callClaude/.test(SRC), 'callClaude must be async');
  assert.ok(/await.*provider\.spawn/.test(SRC), 'callClaude must await provider.spawn(...)');
});

test('(CM3) compress-memory.js contains no direct spawnSync("claude") call', () => {
  assert.ok(
    !SRC.includes("spawnSync('claude'") && !SRC.includes('spawnSync("claude"'),
    'compress-memory.js must not contain spawnSync("claude") — must route through provider'
  );
});

if (_failed === 0) console.log('\nAll compress-memory-provider tests passed.');
else console.error(`\n${_failed} compress-memory-provider test(s) FAILED.`);
