#!/usr/bin/env node
'use strict';

/**
 * Regression test for the ReferenceError: stopReason is not defined bug
 * in autoAnswerClarifyingQuestionsClarifyingQuestions().
 *
 * Bug: the destructure of the initial `callOnce('')` result at the top of the
 * fn previously omitted `stopReason` and `continuations`, but the subsequent
 * buildUsageFooter call passed them in `{ stopReason, continuations }`,
 * throwing ReferenceError before appendToFile ran, so the
 * "## User Reply to Clarifying Questions" header never landed in history.
 *
 * Run: node Agent_Orchestrator/tests/auto-answer-clarifying-questions-stop-reason.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Initial destructure of callOnce('') must include stopReason and continuations.
test('initial callOnce destructure includes stopReason + continuations', () => {
  const re = /let\s*\{\s*([^}]+)\}\s*=\s*await\s+callOnce\(''\)/;
  const m = runAgentSrc.match(re);
  assert.ok(m, 'expected `let { ... } = await callOnce(\'\')` destructure');
  const fields = m[1].split(',').map(s => s.trim());
  assert.ok(fields.includes('stopReason'), `expected stopReason in destructure, got: ${fields.join(', ')}`);
  assert.ok(fields.includes('continuations'), `expected continuations in destructure, got: ${fields.join(', ')}`);
});

// Retry-merge re-assignment must carry stopReason + continuations too.
test('retry-merge re-assignment carries stopReason + continuations', () => {
  const re = /\(\s*\{\s*([^}]+)\}\s*=\s*retry\s*\)/;
  const m = runAgentSrc.match(re);
  assert.ok(m, 'expected `({ ... } = retry)` retry-merge re-assignment');
  const fields = m[1].split(',').map(s => s.trim());
  assert.ok(fields.includes('stopReason'), `expected stopReason in retry-merge, got: ${fields.join(', ')}`);
  assert.ok(fields.includes('continuations'), `expected continuations in retry-merge, got: ${fields.join(', ')}`);
});

// Footer call must still reference both names — sanity guard that we aren't
// hiding the bug by removing the reference instead of fixing the destructure.
test('buildUsageFooter is invoked with { stopReason, continuations }', () => {
  const idx = runAgentSrc.indexOf('callOnce(\'\')');
  assert.ok(idx > 0, 'callOnce(\'\') anchor not found');
  const tail = runAgentSrc.slice(idx, idx + 6000);
  assert.ok(/buildUsageFooter\([^)]*\{\s*stopReason\s*,\s*continuations\s*\}\s*\)/.test(tail),
    'expected buildUsageFooter(..., { stopReason, continuations }) after the initial callOnce');
});

if (_failed === 0) console.log('\nAll stop-reason regression tests passed.');
