#!/usr/bin/env node
'use strict';

// Behavioral tests for the `parallel-assessment-agents` key (mandate: a test
// per parallel key proving its DESCRIBED behavior, not source-grep).
// Described contract: default OFF; only literal true / "true" enables parallel
// assessors; topic scope overrides global; everything else stays serial.
// Run: node Agent_Orchestrator/tests/parallel-assessment-agents-resolution.test.js

const assert = require('assert');
const configUtils = require('../src/config-utils');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

const r = (t, g) => configUtils.resolveParallelAssessmentAgents(t, g);

test('default OFF when neither scope sets the key', () => {
  assert.strictEqual(r({}, {}), false);
  assert.strictEqual(r(null, null), false);
});

test('topic boolean true enables parallel assessors', () => {
  assert.strictEqual(r({ 'parallel-assessment-agents': true }, {}), true);
});

test('topic string "true" enables parallel assessors', () => {
  assert.strictEqual(r({ 'parallel-assessment-agents': 'true' }, {}), true);
});

test('global true is honored when topic is silent', () => {
  assert.strictEqual(r({}, { 'parallel-assessment-agents': true }), true);
});

test('topic false overrides global true (topic-over-global)', () => {
  assert.strictEqual(r({ 'parallel-assessment-agents': false }, { 'parallel-assessment-agents': true }), false);
});

test('camelCase alias resolves at topic scope', () => {
  assert.strictEqual(r({ parallelAssessmentAgents: true }, {}), true);
});

test('non-boolean junk stays serial (no truthy coercion)', () => {
  assert.strictEqual(r({ 'parallel-assessment-agents': 'yes' }, {}), false);
  assert.strictEqual(r({ 'parallel-assessment-agents': 1 }, {}), false);
});
