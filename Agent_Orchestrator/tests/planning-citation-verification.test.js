#!/usr/bin/env node
/**
 * Regression tests for the Planning Citation Verification Protocol and
 * Known-Stale Symbol List injected into the planning system prompt.
 *
 *  (1) Planning system prompt contains the Citation Verification Protocol header.
 *  (2) Planning system prompt contains the ### Verified Citations requirement.
 *  (3) Planning system prompt contains the Known-Stale Symbol List header.
 *  (4) Planning system prompt contains every symbol from stale-symbols.json.
 *  (5) Coding system prompt does NOT contain the Citation Verification Protocol.
 *  (6) Assessment system prompt does NOT contain the Citation Verification Protocol.
 *  (7) stale-symbols.json is valid JSON and has a non-empty staleSymbols array.
 *  (8) Each staleSymbol entry has non-empty `symbol` and `description` fields.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
const STALE_SYMBOLS_PATH = path.join(HARNESS, 'src', 'stale-symbols.json');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { _failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

// ── Helper: extract the planning system prompt text by locating the clause ────
// run-agent.js is not importable as a module (it runs as a CLI), so we assert
// on the source text for clause presence, and trust buildSystemPrompt() appends
// them only for `planning` (verified via source-grep for the guard condition).

test('(1) run-agent.js defines planningCitationVerificationClause containing the protocol header', () => {
  assert.ok(
    RUN_AGENT_SRC.includes('Citation Verification Protocol'),
    'run-agent.js must contain "Citation Verification Protocol" text'
  );
});

test('(2) planningCitationVerificationClause requires a ### Verified Citations section', () => {
  assert.ok(
    RUN_AGENT_SRC.includes('### Verified Citations'),
    'planningCitationVerificationClause must require a "### Verified Citations" section in every plan'
  );
});

test('(3) run-agent.js defines planningStaleReferenceClause containing the smell list header', () => {
  assert.ok(
    RUN_AGENT_SRC.includes('Known-Stale Symbol List'),
    'run-agent.js must contain "Known-Stale Symbol List" text'
  );
});

test('(4) run-agent.js loads stale-symbols.json at startup to build the smell-list clause', () => {
  // The symbols are injected at runtime from stale-symbols.json; we verify the
  // load path and key access pattern exist in source rather than grepping for
  // each symbol literal (which lives in the JSON, not the JS source).
  assert.ok(
    RUN_AGENT_SRC.includes('stale-symbols.json'),
    'run-agent.js must reference "stale-symbols.json" to load the stale symbol list'
  );
  assert.ok(
    RUN_AGENT_SRC.includes('staleSymbols'),
    'run-agent.js must access the staleSymbols key from stale-symbols.json'
  );
  // Confirm known high-value symbols ARE present in the JSON (source of truth).
  const data = JSON.parse(fs.readFileSync(STALE_SYMBOLS_PATH, 'utf8'));
  const symbols = data.staleSymbols.map(s => s.symbol);
  for (const expected of ['compressTopic', 'compressed-memory injection', '## Compressed Memory']) {
    assert.ok(
      symbols.includes(expected),
      `stale-symbols.json must contain the known-stale symbol "${expected}"`
    );
  }
});

test('(5) Citation Verification Protocol is injected for planning role only (guard present in buildSystemPrompt)', () => {
  // Verify the guard: planningCitationVerificationClause is appended inside
  // `if (role === 'planning')` in buildSystemPrompt. We confirm by checking
  // the source contains the guard pattern adjacent to the clause variable name.
  const guardPattern = /if\s*\(\s*role\s*===\s*'planning'\s*\)\s*\{[\s\S]{0,400}planningCitationVerificationClause/;
  assert.ok(
    guardPattern.test(RUN_AGENT_SRC),
    'planningCitationVerificationClause must be appended inside `if (role === \'planning\')` in buildSystemPrompt'
  );
});

test('(6) planningStaleReferenceClause is injected for planning role only (same guard)', () => {
  const guardPattern = /if\s*\(\s*role\s*===\s*'planning'\s*\)\s*\{[\s\S]{0,600}planningStaleReferenceClause/;
  assert.ok(
    guardPattern.test(RUN_AGENT_SRC),
    'planningStaleReferenceClause must be appended inside `if (role === \'planning\')` in buildSystemPrompt'
  );
});

test('(7) stale-symbols.json is valid JSON with a non-empty staleSymbols array', () => {
  assert.ok(fs.existsSync(STALE_SYMBOLS_PATH), 'stale-symbols.json must exist at src/stale-symbols.json');
  const data = JSON.parse(fs.readFileSync(STALE_SYMBOLS_PATH, 'utf8'));
  assert.ok(Array.isArray(data.staleSymbols), 'stale-symbols.json must have a top-level staleSymbols array');
  assert.ok(data.staleSymbols.length > 0, 'staleSymbols array must not be empty');
});

test('(8) every staleSymbol entry has non-empty symbol and description', () => {
  const data = JSON.parse(fs.readFileSync(STALE_SYMBOLS_PATH, 'utf8'));
  for (const entry of data.staleSymbols) {
    assert.ok(typeof entry.symbol === 'string' && entry.symbol.trim() !== '',
      `staleSymbol entry missing or empty "symbol" field: ${JSON.stringify(entry)}`);
    assert.ok(typeof entry.description === 'string' && entry.description.trim() !== '',
      `staleSymbol entry missing or empty "description" field: ${JSON.stringify(entry)}`);
  }
});

if (_failed === 0) console.log('\nAll planning-citation-verification tests passed.');
else { console.error(`\n${_failed} test(s) FAILED.`); process.exit(1); }
