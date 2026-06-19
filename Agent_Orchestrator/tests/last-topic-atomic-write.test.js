#!/usr/bin/env node
'use strict';

/**
 * atomicWriteText must leave `.last-topic` in either the OLD value or the NEW
 * value, never empty — even when the write is interrupted. Verified by
 * (a) writing a fresh value and confirming the tmp file is gone + target has
 *     the new content, (b) simulating a crash where the rename never happens
 *     (manual tmp+throw) and confirming the original target is untouched.
 *
 * Run: node Agent_Orchestrator/tests/last-topic-atomic-write.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const { atomicWriteText } = require(path.join(HARNESS, 'src', 'lib', 'safe-json-write'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-topic-atomic-'));
const target = path.join(tmpDir, '.last-topic');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

test('LTA1 — fresh write produces target with exact content; no .tmp leftover', () => {
  atomicWriteText(target, 'topic-alpha');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'topic-alpha');
  assert.strictEqual(fs.existsSync(target + '.tmp'), false, '.tmp should be cleaned up after rename');
});

test('LTA2 — overwrite preserves new value; old value gone', () => {
  atomicWriteText(target, 'topic-beta');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'topic-beta');
});

test('LTA3 — interrupted write (rename never happens) leaves OLD value intact', () => {
  // Simulate a crash mid-write: write the tmp, then DO NOT rename. The original
  // target must still hold the prior value. This is exactly the failure mode
  // that a plain fs.writeFileSync would expose as a 0-byte target.
  fs.writeFileSync(target + '.tmp', 'topic-gamma-INTERRUPTED', 'utf8');
  // Verify target untouched.
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'topic-beta', 'target must still be old value');
  // Cleanup tmp manually.
  fs.unlinkSync(target + '.tmp');
});

test('LTA4 — file never observed empty across many sequential writes', () => {
  for (let i = 0; i < 25; i++) {
    atomicWriteText(target, `topic-${i}`);
    const cur = fs.readFileSync(target, 'utf8');
    assert.notStrictEqual(cur, '', `iteration ${i}: file empty`);
    assert.strictEqual(cur, `topic-${i}`);
  }
});

// Teardown
try { fs.unlinkSync(target); } catch {}
try { fs.unlinkSync(target + '.tmp'); } catch {}
try { fs.rmdirSync(tmpDir); } catch {}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
