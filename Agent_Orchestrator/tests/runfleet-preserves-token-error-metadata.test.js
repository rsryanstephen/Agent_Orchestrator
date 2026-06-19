#!/usr/bin/env node
'use strict';

/**
 * Regression: runFleet must preserve typed token-error metadata on rethrow.
 *
 * Run: node --test Agent_Orchestrator/tests/runfleet-preserves-token-error-metadata.test.js
 *
 * runFleet (src/run-agent.js) rethrows each parallel subtask failure with a
 * [task-N] prefix via the pure, hoisted `_prefixFleetError` seam. Previously it
 * wrapped failures in `new Error(...)`, dropping typed props (tokenReset/
 * tokensExhausted/monthlyCapHit/cliOutput) so the runPipeline catch block could
 * no longer fire the inline session-limit countdown or _tryProviderFallback for
 * parallel coding/assessment/fix fleets. These tests fail against the pre-fix
 * source (new Error drops the props).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const HARNESS = path.join(__dirname, '..');
const { _prefixFleetError } = require(path.join(HARNESS, 'src', 'run-agent'));

// Mirror runFleet's catch arm exactly so the assertion exercises the same
// rethrow path the production fleet uses for each subtask.
async function runFleetSingle(taskFn, label) {
  try {
    return await taskFn();
  } catch (err) {
    throw _prefixFleetError(err, label);
  }
}

// Requirement bullet: "replace `throw new Error(\`[${labels[i]}] ${err.message}\`)`
// with `err.message = \`[${labels[i]}] ${err.message}\`; throw err;` so
// `tokenReset`/`tokensExhausted`/`monthlyCapHit`/`cliOutput` survive the rethrow"
test('runFleet rethrow preserves tokenReset/tokensExhausted and prefixes [task-1]', async () => {
  const taskFn = async () => {
    const e = new Error('Claude exited with code 1');
    e.tokenReset = '2026-06-15T18:00:00Z';
    e.tokensExhausted = true;
    e.monthlyCapHit = false;
    e.cliOutput = 'tokens have run out';
    throw e;
  };

  let caught;
  try {
    await runFleetSingle(taskFn, 'task-1');
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'expected runFleet to rethrow');
  assert.strictEqual(caught.tokenReset, '2026-06-15T18:00:00Z');
  assert.strictEqual(caught.tokensExhausted, true);
  assert.strictEqual(caught.monthlyCapHit, false);
  assert.strictEqual(caught.cliOutput, 'tokens have run out');
  assert.strictEqual(caught.message, '[task-1] Claude exited with code 1');
});

// Requirement bullet: rethrow must "reach the `runPipeline` catch block ...
// enabling both the inline session-limit countdown and the `_tryProviderFallback`
// cross-provider swap" — i.e. the SAME error object is preserved, not a copy.
test('_prefixFleetError returns the same error instance (identity preserved)', () => {
  const e = new Error('boom');
  e.tokensExhausted = true;
  const out = _prefixFleetError(e, 'task-2');
  assert.strictEqual(out, e, 'must return the original error instance');
  assert.strictEqual(out.tokensExhausted, true);
  assert.strictEqual(out.message, '[task-2] boom');
});
