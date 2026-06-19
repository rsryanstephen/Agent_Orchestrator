#!/usr/bin/env node
'use strict';

// Tests for the Step 4 pre-flight model-availability fallback.
// Five cases (per planning agent spec):
//   (a) configured-but-missing model in fresh cache -> coerced to "auto" and
//       resolved to provider heavy tier.
//   (b) configured-and-present model -> passes through unchanged.
//   (c) catalog stale/missing for provider -> pass-through (no coerce).
//   (d) auto + non-claude-code provider -> heavy tier regardless of prompt size.
//   (e) auto + claude-code + trivial prompt -> still resolves to haiku (light tier).
//
// Strategy: cases (a)/(b)/(c) are anchored in `isModelAvailable` runtime behavior
// fed by a fixture `.model-catalog-cache.json` written to a tmp HARNESS via the
// MODEL_CATALOG_CACHE_PATH env var. Cases (a)/(d)/(e) additionally assert the
// `run-agent.js` source-text contract that the pre-flight coercion and the
// provider-aware `autoClassifyModel` branch are wired into the resolveModel path,
// since `resolveModel` and `autoClassifyModel` are module-scoped (no exports).
//
// Run: node Agent_Orchestrator/tests/model-preflight-fallback.test.js

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const assert = require('assert');

const HARNESS   = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── Stage tmp HARNESS fixture cache ──────────────────────────────────────────
// Write a fresh fixture with one provider (`github-copilot`) listing only the
// gpt-4.1 family. `claude-code` is intentionally absent so the "stale/unknown
// provider" branch is exercised for case (c).
const tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'mpf-'));
const fixturePath = path.join(tmpDir, '.model-catalog-cache.json');
const fixture = {
  fetchedAt: Date.now(),
  providers: {
    'github-copilot': {
      models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
      tiers:  { heavy: 'gpt-4.1', medium: 'gpt-4.1', light: 'gpt-4.1-mini' },
    },
  },
};
fs.writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');
process.env.MODEL_CATALOG_CACHE_PATH = fixturePath;

// Reload module so the env-var-driven cache path is picked up on first load.
const modPath = require.resolve('../src/lib/model-catalog.js');
delete require.cache[modPath];
const catalog = require('../src/lib/model-catalog.js');

const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');

// ── (a) configured-but-missing -> coerced to auto -> provider heavy ──────────

test('(a) isModelAvailable flags "gpt-5.4" as absent for github-copilot (triggers auto coercion)', () => {
  const r = catalog.isModelAvailable('github-copilot', 'gpt-5.4');
  assert.strictEqual(r.available, false, 'gpt-5.4 must NOT be marked available against the fixture');
  assert.strictEqual(r.stale, false, 'fixture cache is fresh — stale must be false to trigger coercion');
});

test('(a) run-agent.js: resolveModel awaits ensureFreshCache + isModelAvailable and coerces to "auto" on absent+fresh', () => {
  assert.ok(/isModelAvailable\s*\(/.test(runAgentSrc),
    'resolveModel must invoke isModelAvailable for pre-flight check');
  assert.ok(/ensureFreshCache\s*\(/.test(runAgentSrc),
    'resolveModel must invoke ensureFreshCache before the availability check');
  assert.ok(/falling back to auto/i.test(runAgentSrc),
    'resolveModel must log a "falling back to auto" message when the configured id is absent from a fresh catalog');
});

// ── (b) configured-and-present -> passes through ─────────────────────────────

test('(b) isModelAvailable confirms "gpt-4.1" present -> resolveModel must pass through unchanged', () => {
  const r = catalog.isModelAvailable('github-copilot', 'gpt-4.1');
  assert.strictEqual(r.available, true, 'gpt-4.1 must be marked available against the fixture');
  assert.strictEqual(r.stale, false);
});

// ── (c) catalog stale/unknown provider -> pass-through (no coerce) ───────────

test('(c) isModelAvailable returns stale=true for absent provider (claude-code) — caller must pass-through', () => {
  const r = catalog.isModelAvailable('claude-code', 'claude-opus-4-8');
  assert.strictEqual(r.stale, true, 'absent provider entry => stale (do NOT coerce)');
});

test('(c) run-agent.js: pre-flight branch guards coercion on cache freshness (stale => pass-through)', () => {
  // Either an explicit `!stale` guard or a check that available is unambiguously false on a fresh catalog.
  assert.ok(/stale\s*===\s*false|!\s*\w*\.?stale|stale\s*!==\s*true/.test(runAgentSrc),
    'coercion branch must guard on cache freshness so stale catalogs do not trigger fallback');
});

// ── (d) auto + non-claude provider -> heavy tier regardless of prompt size ───

test('(d) run-agent.js: resolveModel auto branch picks providerTiers.heavy for non-claude-code', () => {
  // Provider-aware auto path lives in resolveModel (run-agent.js:842-846): claude-code
  // uses complexity tiering, every other provider returns the strongest available tier.
  const branchPattern = /effectiveProvider\s*===\s*['"]claude-code['"][\s\S]{0,400}?providerTiers\.heavy/;
  assert.ok(branchPattern.test(runAgentSrc),
    'resolveModel auto branch must select providerTiers.heavy when effectiveProvider !== claude-code');
});

// ── (e) auto + claude-code + trivial prompt -> haiku (light tier) ────────────

test('(e) run-agent.js: claude-code retains complexity-score ladder (light tier still reachable on trivial prompts)', () => {
  // The existing ladder `if (score <= 1) return tiers.light;` must survive the
  // provider-aware refactor for claude-code, otherwise trivial prompts stop
  // reaching haiku.
  assert.ok(/score\s*<=\s*1\s*\)\s*return\s+tiers\.light/.test(runAgentSrc),
    'claude-code complexity ladder must still return tiers.light (haiku) for score <= 1');
});

// ── (f) resolveModelId family-keyword -> LATEST_* spec ───────────────────────
// Spec: bare `opus` / `Opus` as a queue header must resolve to the current
// LATEST_OPUS constant (claude-opus-4-8). Title-case must behave identically.

const { resolveModelId } = require('../src/run-agent.js');

test('(f) resolveModelId(\'opus\') maps to current LATEST_OPUS (claude-opus-4-8)', () => {
  const id = resolveModelId('opus');
  assert.strictEqual(id, 'claude-opus-4-8',
    'bare family keyword opus must resolve to claude-opus-4-8');
});

test('(f) resolveModelId(\'Opus\') title-case maps identically (case-insensitive)', () => {
  const id = resolveModelId('Opus');
  assert.strictEqual(id, 'claude-opus-4-8',
    'title-case Opus must resolve to same id as lowercase opus');
});

test('(f) run-agent.js spec wiring: unavailable Opus on claude-code falls back to autoClassifyModel', () => {
  // Spec: if LATEST_OPUS is unavailable in the catalog for claude-code, the harness
  // must use "auto determined most appropriate model for the current question" —
  // i.e. autoClassifyModel is invoked, NOT a hard-coded tier fallback.
  assert.ok(
    /effectiveProvider\s*===\s*['"]claude-code['"]\s*\)\s*\{[\s\S]{0,200}?autoClassifyModel/.test(runAgentSrc),
    'resolveModel auto branch for claude-code must call autoClassifyModel (complexity-based selection)');
});

test('(f) run-agent.js spec wiring: unavailable model on non-claude-code falls back to providerTiers.heavy', () => {
  // Spec: if Opus is unavailable and provider is NOT claude-code, harness must
  // use the provider\'s latest valid model (heavy tier).
  assert.ok(
    /providerTiers\.heavy\s*\|\|/.test(runAgentSrc),
    'resolveModel auto branch must include providerTiers.heavy fallback for non-claude-code providers');
});

// ── Cleanup ─────────────────────────────────────────────────────────────────
process.on('exit', () => {
  try { fs.unlinkSync(fixturePath); fs.rmdirSync(tmpDir); } catch {}
});

if (_failed === 0) console.log('\nAll model-preflight tests passed.');
else { console.error(`\n${_failed} test(s) FAILED.`); process.exit(1); }
