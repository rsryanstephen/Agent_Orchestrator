#!/usr/bin/env node
'use strict';

// Regression for two coupled changes in run-agent.js:
//  (1) `--dump-prompt` dev diagnostic — prints each base role's fully-assembled
//      system prompt to stdout then exits, so a grep can deterministically prove a
//      clause (e.g. `## Caveman Mode`) actually lands in the prompt.
//  (2) Relaxed OUTPUT FORMATTING mandate — the prose-forcing "one sentence per
//      bullet" rule was rewritten to permit telegraphic/caveman WITHIN-bullet
//      wording, while bullet STRUCTURE + ONE-blank-line spacing stay non-negotiable.
//
// Run: node Agent_Orchestrator/tests/dump-prompt-and-mandate-relax.test.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { execFileSync } = require('child_process');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const src = fs.readFileSync(RUN_AGENT, 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e && (e.message || e)}`); }
}

// Bound the mandate clause source for targeted assertions.
function mandateSrc() {
  const start = src.indexOf('const outputFormattingMandateClause');
  const end = src.indexOf('function resolveStrictAssessmentClause', start);
  assert.ok(start >= 0 && end > start, 'could not bound outputFormattingMandateClause source');
  return src.slice(start, end);
}

test('mandate NO LONGER contains literal "one sentence per bullet"', () => {
  assert.ok(!/one sentence per bullet/.test(mandateSrc()),
    'relaxed mandate must drop the prose-forcing "one sentence per bullet" rule');
});

test('mandate permits telegraphic/caveman within-bullet wording', () => {
  const m = mandateSrc();
  assert.ok(/telegraphic/.test(m) && /one idea per bullet/.test(m),
    'mandate must allow telegraphic, one-idea-per-bullet bodies');
});

test('mandate keeps non-negotiable bullet structure + ONE BLANK LINE spacing', () => {
  const m = mandateSrc();
  assert.ok(/ONE BLANK LINE/.test(m), 'ONE BLANK LINE rule must survive relaxation');
  assert.ok(/begin with `- `/.test(m), 'bullet `- ` prefix rule must survive relaxation');
});

test('--dump-prompt handler is wired in run-agent.js', () => {
  assert.ok(/const dumpPrompt = process\.argv\.includes\('--dump-prompt'\)/.test(src),
    'dumpPrompt flag detection must exist');
  assert.ok(/if \(dumpPrompt\) \{/.test(src), 'dump handler block must exist');
});

test('--dump-prompt emits all three base-role headers + Caveman clause', () => {
  const out = execFileSync('node', [RUN_AGENT, 'harness_dev', '--dump-prompt'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const role of ['planning', 'coding', 'assessment']) {
    assert.ok(out.includes(`DUMP-PROMPT role=${role}`), `dump must emit header for role=${role}`);
  }
  // Caveman is active in the harness_dev topic config, so the clause must land.
  assert.ok(out.includes('## Caveman Mode (output style — mandatory)'),
    'dump must prove the Caveman clause lands in the assembled prompt');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
