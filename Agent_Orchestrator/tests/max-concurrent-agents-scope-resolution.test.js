#!/usr/bin/env node
'use strict';

// Regression tests for getMaxConcurrentAgents scope-resolution bug.
// A TOPIC-level value of either `max-parallel-agents-per-topic` (new) or
// `max-concurrent-agents` (legacy) must beat a GLOBAL value of either key.
// Run: node Agent_Orchestrator/tests/max-concurrent-agents-scope-resolution.test.js

const assert = require('assert');
const configUtils = require('../src/config-utils');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

const DEFAULT = 8;
const r = (t, g) => configUtils.resolveMaxConcurrentAgents(t, g, DEFAULT);

// The exact bug: global new key shadowing topic legacy key.
test('topic legacy max-concurrent-agents:4 beats global new max-parallel-agents-per-topic:10', () => {
  const topic = { 'max-concurrent-agents': 4 };
  const global = { 'max-parallel-agents-per-topic': 10 };
  assert.strictEqual(r(topic, global), 4);
});

test('topic new key beats global legacy key', () => {
  assert.strictEqual(r({ 'max-parallel-agents-per-topic': 3 }, { 'max-concurrent-agents': 9 }), 3);
});

test('within topic scope, new key wins over legacy key', () => {
  assert.strictEqual(r({ 'max-parallel-agents-per-topic': 5, 'max-concurrent-agents': 2 }, {}), 5);
});

test('falls to global when topic sets neither (new key preferred globally)', () => {
  assert.strictEqual(r({}, { 'max-parallel-agents-per-topic': 6, 'max-concurrent-agents': 2 }), 6);
});

test('global legacy key honored when global new key absent', () => {
  assert.strictEqual(r({}, { 'max-concurrent-agents': 7 }), 7);
});

test('value of 1 is honored (serial), not treated as falsy fallback', () => {
  assert.strictEqual(r({ 'max-concurrent-agents': 1 }, { 'max-parallel-agents-per-topic': 10 }), 1);
});

test('returns fallback when neither scope sets a usable value', () => {
  assert.strictEqual(r({}, {}), DEFAULT);
  assert.strictEqual(r({ 'max-concurrent-agents': 0 }, {}), DEFAULT);
  assert.strictEqual(r(null, null), DEFAULT);
});

test('camelCase alias resolves at topic scope', () => {
  assert.strictEqual(r({ maxConcurrentAgents: 4 }, { 'max-parallel-agents-per-topic': 10 }), 4);
});
