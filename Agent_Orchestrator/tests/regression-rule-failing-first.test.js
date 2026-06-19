#!/usr/bin/env node
'use strict';

// Lint-style regression rule: every test file matching *regression* or *bug*
// patterns under tests/ must exercise behavior via a real call site
// (spawn/fork/require) and must NOT degrade into source-grep assertions
// (src.includes / SRC.includes). Source-grep checks lock prose in place rather
// than verifying behavior and were the root cause of multiple H1/H3 hypotheses
// in test-suite-diagnostic.md.
//
// Run: node Agent_Orchestrator/tests/regression-rule-failing-first.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TESTS_DIR = __dirname;

function listRegressionFiles() {
  // Enumerate test files whose basename matches the regression/bug naming
  // conventions; case-insensitive to catch any future variants.
  const all = fs.readdirSync(TESTS_DIR);
  return all.filter((name) => {
    if (!name.endsWith('.test.js')) return false;
    const lower = name.toLowerCase();
    if (lower === path.basename(__filename).toLowerCase()) return false;
    return lower.includes('regression') || lower.includes('bug');
  });
}

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e && (e.message || e)}`);
  }
}

// Confirms each candidate file invokes real harness code via a spawn/fork or
// require call site instead of relying solely on textual inspection of source.
test('regression/bug tests use real call sites (spawn/fork/require)', () => {
  const files = listRegressionFiles();
  const missing = [];
  const callSiteRe = /\b(spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\(|\brequire\s*\(\s*['"]/;
  for (const f of files) {
    const txt = fs.readFileSync(path.join(TESTS_DIR, f), 'utf8');
    if (!callSiteRe.test(txt)) missing.push(f);
  }
  assert.strictEqual(
    missing.length, 0,
    `Regression/bug tests missing a spawn(), fork(), execFile(), or require('...') call-site assertion:\n  - ${missing.join('\n  - ')}`
  );
});

// Bans the source-grep antipattern (asserting on contents of a src/ file via
// src.includes / SRC.includes) which locks prose rather than behavior.
test('regression/bug tests do not use src.includes/SRC.includes source-grep antipattern', () => {
  const files = listRegressionFiles();
  const offenders = [];
  const banRe = /\b(?:src|SRC)\s*\.\s*includes\s*\(/;
  for (const f of files) {
    const txt = fs.readFileSync(path.join(TESTS_DIR, f), 'utf8');
    if (banRe.test(txt)) offenders.push(f);
  }
  assert.strictEqual(
    offenders.length, 0,
    `Regression/bug tests use forbidden src.includes/SRC.includes source-grep antipattern:\n  - ${offenders.join('\n  - ')}`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
