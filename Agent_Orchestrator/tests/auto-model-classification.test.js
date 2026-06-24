#!/usr/bin/env node
'use strict';

// Regression tests for the auto model-tier classifier fix.
// Bug: `autoClassifyModel` heavy gate (score > 5) was too low, so verbose-but-
// routine prompts inflated `computePromptScore` into the heavy (Opus) tier —
// "almost always Opus". Compounded by `applyPlanningEffortAndModel` scoring the
// verbose PLAN output instead of the original user prompt.
// Run: node Agent_Orchestrator/tests/auto-model-classification.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RUN_AGENT = path.join(__dirname, '..', 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Extract the three pure-ish classifier functions from source and evaluate them
// with a stubbed `_loadProviderTiers`, so we exercise REAL behavior without the
// top-level CLI side effects of requiring run-agent.js.
function extract(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name} from run-agent.js`);
  return m[0];
}

const tiers = { light: 'haiku', medium: 'sonnet', heavy: 'opus' };
// eslint-disable-next-line no-new-func
const factory = new Function(
  '_loadProviderTiers',
  `${extract('computePromptScore')}\n${extract('autoClassifyEffort')}\n${extract('autoClassifyModel')}\n` +
  'return { computePromptScore, autoClassifyEffort, autoClassifyModel };'
);
const { computePromptScore, autoClassifyModel } = factory(() => tiers);

// ── Behavioral classification cases ─────────────────────────────────────────────
test('(a) short trivial prompt -> light (Haiku)', () => {
  assert.strictEqual(autoClassifyModel('fix typo in readme', 'claude-code'), 'haiku');
});

test('(b) typical multi-bullet feature prompt -> medium (Sonnet), not heavy', () => {
  const prompt = [
    'Add a new endpoint to the users service.',
    '- accept a JSON body',
    '- validate the email field',
    '- update the database record',
    '- return the updated user',
    '- add a unit test',
  ].join('\n');
  assert.strictEqual(autoClassifyModel(prompt, 'claude-code'), 'sonnet');
});

test('(c) explicit architecture + long + many reqs -> heavy (Opus)', () => {
  const prompt = ('We need a full architecture redesign and comprehensive overhaul. ' +
    'Refactor all modules, restructure the pipeline, extract abstractions. ').repeat(20) +
    '\n- add\n- update\n- create\n- remove\n- implement\n- refactor';
  assert.strictEqual(autoClassifyModel(prompt, 'claude-code'), 'opus');
});

test('(d) verbose plan over a simple prompt -> still medium when scored on prompt', () => {
  // The verbose plan output WOULD score heavy; the original prompt must not.
  const verbosePlan = ('1. implement the change\n2. refactor the helper\n3. integrate the module\n' +
    '4. update the tests\n5. create the fixture\n').repeat(30);
  assert.strictEqual(autoClassifyModel(verbosePlan, 'claude-code'), 'opus',
    'precondition: verbose plan DOES inflate to heavy — that is why we must score the prompt instead');
  const originalPrompt = 'add a null check to the parser';
  assert.strictEqual(autoClassifyModel(originalPrompt, 'claude-code'), 'haiku');
});

test('(e) brief-but-architectural prompt -> heavy (Opus), not eliminated by low score', () => {
  // Low raw score (no length/bullet inflation) but a genuine architecture signal
  // must still reach Opus — Opus is reserved for hard tasks, not eliminated.
  assert.strictEqual(autoClassifyModel('redesign the auth architecture from scratch', 'claude-code'), 'opus');
  // Brief routine prompt of similar length must NOT reach heavy.
  assert.notStrictEqual(autoClassifyModel('add a retry to the http client call', 'claude-code'), 'opus');
});

// ── Source-wiring guards (Fix 1 + Fix 2) ────────────────────────────────────────
test('Fix 1: heavy gate raised to score <= 8 -> medium', () => {
  assert.ok(/if \(score <= 8\) return tiers\.medium;/.test(src),
    'autoClassifyModel must widen the medium band to score <= 8');
});

test('Fix 2: applyPlanningEffortAndModel scores the original prompt for model tier', () => {
  assert.ok(/function applyPlanningEffortAndModel\(planningText, promptForModel\)/.test(src),
    'applyPlanningEffortAndModel must accept promptForModel');
  assert.ok(/const modelSource = \(promptForModel && promptForModel\.trim\(\)\) \? promptForModel : planningText;/.test(src),
    'model tier must be derived from promptForModel with planningText fallback');
  assert.ok(/applyPlanningEffortAndModel\(text, context\)/.test(src),
    'call site must pass the original user prompt (context) as the model-tier signal');
});

if (!process.exitCode) console.log('\nAll auto-model-classification tests passed.');
