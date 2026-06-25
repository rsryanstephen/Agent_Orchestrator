#!/usr/bin/env node
'use strict';

// Regression tests for install-shell-functions.js.
// Run: node Agent_Orchestrator/tests/install-shell-functions.test.js
//
// Covers:
//  (1)  Idempotence: source contains managed-block check that skips re-install
//  (2)  --force replaces managed block: source contains replace logic for existing block
//  (3)  LEGACY_FNS list contains expected legacy names
//  (4)  BEGIN/END sentinel markers defined with correct verbatim values
//  (5)  {{HARNESS_ROOT}} placeholder in shell-functions.txt is substituted by renderSource
//  (6)  install() returns { ok: false } when source file missing (guard in source)
//  (7)  --force strips legacy unmanaged function definitions (source-level)
//  (8)  module exports `install` as a named function
//  (9)  shell-functions.txt is referenced as SOURCE in installer
// (10)  managed block template includes do-not-edit comment

const fs   = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const INSTALL_SRC_PATH = path.join(HARNESS, 'src', 'install-shell-functions.js');
const SHELL_FNS_PATH   = path.join(HARNESS, 'shell-functions.txt');

const installSrc  = fs.readFileSync(INSTALL_SRC_PATH, 'utf8');
const shellFnsSrc = fs.readFileSync(SHELL_FNS_PATH, 'utf8');
const installMod  = require(INSTALL_SRC_PATH);

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

const BEGIN = '# >>> Agent_Orchestrator shell functions >>>';
const END   = '# <<< Agent_Orchestrator shell functions <<<';

// ── (1) idempotence: source checks for managed block before installing ─────────
test('(1) source contains hasBlock guard that skips re-install without --force', () => {
  assert.ok(/const hasBlock/.test(installSrc) || /hasBlock\s*=/.test(installSrc),
    'install source must define hasBlock variable to detect existing managed block');
  assert.ok(/if \(!FORCE && hasBlock/.test(installSrc) || /if \(!force && hasBlock/.test(installSrc),
    'install source must skip install when managed block already present and no --force flag');
  assert.ok(/no changes/.test(installSrc),
    'install source must log "no changes" when block already present');
});

// ── (2) --force replaces existing managed block ───────────────────────────────
test('(2) source: --force path replaces managed block via regex replace', () => {
  assert.ok(/hasBlock && (?:FORCE|force)/.test(installSrc) || /FORCE.*hasBlock|force.*hasBlock/.test(installSrc),
    'install source must have a branch for --force + existing block');
  assert.ok(/content\.replace\(new RegExp/.test(installSrc),
    'install source must use content.replace(new RegExp) to swap out the old managed block');
});

// ── (3) LEGACY_FNS list ───────────────────────────────────────────────────────
test('(3) LEGACY_FNS array contains expected legacy function names', () => {
  const legacyMatch = installSrc.match(/LEGACY_FNS\s*=\s*\[([^\]]+)\]/);
  assert.ok(legacyMatch, 'LEGACY_FNS array must be defined in source');
  const legacyStr = legacyMatch[1];
  for (const name of ['runp', 'runc', 'runa', 'runf', 'runaf', 'runpc', 'runcaf', 'runall', 'runcont', 'runpar']) {
    assert.ok(legacyStr.includes(`'${name}'`) || legacyStr.includes(`"${name}"`),
      `LEGACY_FNS must include '${name}'`);
  }
});

// ── (4) BEGIN/END sentinel markers ───────────────────────────────────────────
test('(4) source defines BEGIN + END sentinel markers with correct verbatim values', () => {
  assert.ok(installSrc.includes(BEGIN),
    'source must define the BEGIN sentinel for the managed block');
  assert.ok(installSrc.includes(END),
    'source must define the END sentinel for the managed block');
});

// ── (5) {{HARNESS_ROOT}} placeholder substituted from shell-functions.txt ─────
test('(5) shell-functions.txt uses {{HARNESS_ROOT}} placeholder; renderSource substitutes it', () => {
  assert.ok(shellFnsSrc.includes('{{HARNESS_ROOT}}'),
    'shell-functions.txt must contain the {{HARNESS_ROOT}} placeholder');
  assert.ok(/renderSource/.test(installSrc),
    'install source must define a renderSource function');
  assert.ok(/HARNESS_ROOT/.test(installSrc),
    'install source must reference HARNESS_ROOT for path substitution');
  assert.ok(/replace\(/.test(installSrc),
    'renderSource must call .replace() to substitute the placeholder');
});

// ── (6) missing source file returns error ─────────────────────────────────────
test('(6) install() guard: SOURCE not found -> ok:false + Source file not found reason', () => {
  assert.ok(/if \(!fs\.existsSync\(SOURCE\)\)/.test(installSrc),
    'install() must guard against missing shell-functions.txt source file');
  assert.ok(/Source file not found/.test(installSrc),
    'install() must include "Source file not found" error reason');
  assert.ok(/failedCount:\s*1/.test(installSrc) || /failedCount\+\+/.test(installSrc),
    'install() must count the failure when source is missing');
});

// ── (7) --force strips legacy unmanaged function definitions ──────────────────
test('(7) source: --force path strips legacy function definitions outside managed block', () => {
  assert.ok(/FORCE && conflicts\.length > 0/.test(installSrc) ||
    /force && conflicts\.length > 0/.test(installSrc),
    'install() must strip conflicting legacy definitions on --force');
  assert.ok(/removed.*unmanaged function definition/.test(installSrc),
    'install() must warn about removed unmanaged function definitions on --force');
  // The removal uses a regex replace over the rc file content.
  assert.ok(/content\.replace\(new RegExp/.test(installSrc),
    'legacy function stripping must use content.replace(new RegExp)');
});

// ── (8) module exports `install` ─────────────────────────────────────────────
test('(8) install-shell-functions.js exports `install` as a named function', () => {
  assert.ok(typeof installMod.install === 'function',
    'module must export `install` as a callable function');
});

// ── (9) shell-functions.txt referenced as SOURCE ─────────────────────────────
test('(9) SOURCE constant in installer points to shell-functions.txt', () => {
  assert.ok(/shell-functions\.txt/.test(installSrc),
    'installer source must reference shell-functions.txt as SOURCE');
  assert.ok(fs.existsSync(SHELL_FNS_PATH),
    'shell-functions.txt must exist at the expected path');
});

// ── (10) managed block template includes do-not-edit comment ─────────────────
test('(10) managed block template includes do-not-edit comment', () => {
  assert.ok(/do not edit by hand/.test(installSrc),
    'managed block template must contain "do not edit by hand" comment');
  assert.ok(/Managed by/.test(installSrc),
    'managed block must identify itself as managed by install-shell-functions.js');
  // Also verify the `--force to refresh` instruction is present in the block header.
  assert.ok(/Re-run with --force to refresh/.test(installSrc),
    'managed block header must instruct user to re-run with --force to refresh');
});

// ── (11) tilde in harness-root is expanded before the src/ existence check ─────
test('(11) resolveHarnessRoot expands ~ so a tilde-prefixed harness-root resolves', () => {
  assert.ok(/expandTilde/.test(installSrc),
    'install source must define an expandTilde helper to expand ~ in harness-root');
  assert.ok(/os\.homedir\(\)/.test(installSrc),
    'expandTilde must resolve ~ to os.homedir()');
  // The expansion must be applied to the config value before fs.existsSync(src) runs,
  // otherwise a "~/..."-prefixed harness-root falsely warns "no src/ subdir".
  assert.ok(/expandTilde\(\s*cfg\[['"]harness-root['"]\]\.trim\(\)\s*\)/.test(installSrc),
    'resolveHarnessRoot must apply expandTilde to the harness-root config value');
});

// ── (12) install persists the auto-detected harness-root back to global config ─
test('(12) renderSource persists resolved harness-root to global-config via writeConfig', () => {
  assert.ok(/writeConfig/.test(installSrc),
    'install source must import/use writeConfig to persist harness-root');
  assert.ok(/function persistHarnessRoot/.test(installSrc),
    'install source must define persistHarnessRoot to record the resolved root');
  assert.ok(/persistHarnessRoot\(root\)/.test(installSrc),
    'renderSource must call persistHarnessRoot(root) after resolving the harness root');
  assert.ok(/cfg\[['"]harness-root['"]\]\s*=\s*root/.test(installSrc),
    'persistHarnessRoot must assign the resolved root to cfg[harness-root]');
  assert.ok(/if \(currentNorm === root\) return/.test(installSrc),
    'persistHarnessRoot must skip the rewrite when the stored value already matches');
});

// ── (13) .bash_profile always written even when .bashrc already exists ────────
test('(13) targets always starts with candidates[0] (.bash_profile) regardless of existing files', () => {
  assert.ok(/\.bash_profile/.test(installSrc),
    'installer must include .bash_profile as a candidate');
  // The targets expression must unconditionally start with candidates[0] so that
  // .bash_profile is written even when .bashrc already exists (typical Git Bash state).
  assert.ok(
    /const targets\s*=\s*\[candidates\[0\]/.test(installSrc),
    'targets must unconditionally start with candidates[0] (.bash_profile)'
  );
  // Regression guard: old conditional form `existing.length > 0 ? existing : [candidates[0]]`
  // would skip creating .bash_profile whenever any rc file already existed.
  assert.ok(
    !/existing\.length\s*>\s*0\s*\?\s*existing\s*:\s*\[candidates\[0\]\]/.test(installSrc),
    'targets must NOT use the conditional that skips .bash_profile when .bashrc exists'
  );
});

if (_failed === 0) console.log('\nAll install-shell-functions tests passed.');
