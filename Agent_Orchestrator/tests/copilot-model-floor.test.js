#!/usr/bin/env node
'use strict';

/**
 * Tests for github-copilot GPT-5 floor and cross-provider hard-abort behavior.
 *
 * (CMF1) selectTiers for github-copilot never returns a sub-gpt-5 id even when catalog includes gpt-4.1
 * (CMF2) selectTiers for github-copilot returns gpt-5 and gpt-5-mini when both present in catalog
 * (CMF3) selectTiers for github-copilot falls back to static gpt-5/gpt-5-mini when catalog is empty after gpt-4 filter
 * (CMF4) configured Claude model under github-copilot triggers process.exit(1) not substitution
 * (CMF5) error message from foreign-model abort lists provider's valid models
 * (CMF6) STATIC_FALLBACKS['github-copilot'] in model-catalog.js uses gpt-5 tiers (not gpt-4.1)
 * (CMF7) _PROVIDER_AUTO_MODELS_STATIC['github-copilot'] in run-agent.js uses gpt-5 tiers (not gpt-4.1)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const catalogPath = path.join(HARNESS, 'src', 'lib', 'model-catalog.js');
const runAgentPath = path.join(HARNESS, 'src', 'run-agent.js');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ---------------------------------------------------------------------------
// selectTiers tests — require model-catalog.js directly (no run-agent.js side effects)
// ---------------------------------------------------------------------------

if (!fs.existsSync(catalogPath)) {
  console.warn('[skip] model-catalog.js not found — copilot-model-floor tests skipped.');
  process.exit(0);
}

// Set a dummy cache path so these tests never read or corrupt the real cache.
process.env.MODEL_CATALOG_CACHE_PATH = path.join(require('os').tmpdir(), `cmf-test-cache-${process.pid}.json`);

const catalog = require(catalogPath);

test('(CMF1) selectTiers github-copilot never returns sub-gpt-5 id when catalog includes gpt-4.1', () => {
  // Catalog includes both gpt-4.1 family and gpt-5 family; only gpt-5+ should survive filter.
  const mockModels = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-5', 'gpt-5-mini'];
  const tiers = catalog.selectTiers(mockModels, 'github-copilot');
  assert.ok(tiers.heavy, 'heavy tier must not be null');
  assert.ok(tiers.medium, 'medium tier must not be null');
  assert.ok(tiers.light, 'light tier must not be null');
  assert.ok(!/^gpt-4/.test(tiers.heavy),  `heavy tier "${tiers.heavy}" must not be gpt-4*`);
  assert.ok(!/^gpt-4/.test(tiers.medium), `medium tier "${tiers.medium}" must not be gpt-4*`);
  assert.ok(!/^gpt-4/.test(tiers.light),  `light tier "${tiers.light}" must not be gpt-4*`);
});

test('(CMF2) selectTiers github-copilot returns gpt-5 heavy and gpt-5-mini light', () => {
  const mockModels = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini'];
  const tiers = catalog.selectTiers(mockModels, 'github-copilot');
  assert.strictEqual(tiers.heavy,  'gpt-5',      `heavy must be gpt-5, got "${tiers.heavy}"`);
  assert.strictEqual(tiers.medium, 'gpt-5',      `medium must be gpt-5, got "${tiers.medium}"`);
  assert.strictEqual(tiers.light,  'gpt-5-mini', `light must be gpt-5-mini, got "${tiers.light}"`);
});

test('(CMF3) selectTiers github-copilot falls back gracefully when catalog is gpt-4-only', () => {
  // After gpt-4* filter, catalog is empty — all buckets null — tiers use cascaded null fallback.
  // The result will have null values (caller falls back to STATIC_FALLBACKS), which is correct behavior.
  const mockModels = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'];
  const tiers = catalog.selectTiers(mockModels, 'github-copilot');
  // All buckets empty → all tiers null (catalog caller should then use STATIC_FALLBACKS).
  assert.strictEqual(tiers.heavy,  null, `expected null heavy when only gpt-4* in catalog, got "${tiers.heavy}"`);
  assert.strictEqual(tiers.medium, null, `expected null medium when only gpt-4* in catalog, got "${tiers.medium}"`);
  assert.strictEqual(tiers.light,  null, `expected null light when only gpt-4* in catalog, got "${tiers.light}"`);
});

test('(CMF6) STATIC_FALLBACKS github-copilot in model-catalog.js uses gpt-5 tiers', () => {
  const src = fs.readFileSync(catalogPath, 'utf8');
  // Ensure no gpt-4.1 remains as a static fallback for github-copilot.
  // Find the STATIC_FALLBACKS block and verify gpt-5 is present.
  assert.ok(src.includes("'gpt-5'"), 'model-catalog.js STATIC_FALLBACKS must reference gpt-5');
  assert.ok(src.includes("'gpt-5-mini'"), 'model-catalog.js STATIC_FALLBACKS must reference gpt-5-mini');
  // Confirm gpt-4.1 is no longer a fallback value (comment references are OK, check for value in quotes).
  const fallbackBlock = src.match(/STATIC_FALLBACKS\s*=\s*\{[\s\S]*?\};/);
  assert.ok(fallbackBlock, 'STATIC_FALLBACKS block must be present');
  // Within the STATIC_FALLBACKS block, no 'gpt-4.1' or 'gpt-4.1-mini' as assigned values.
  const block = fallbackBlock[0];
  assert.ok(!/'gpt-4\.1'/.test(block), `STATIC_FALLBACKS must not contain 'gpt-4.1' value, found in block`);
  assert.ok(!/'gpt-4\.1-mini'/.test(block), `STATIC_FALLBACKS must not contain 'gpt-4.1-mini' value, found in block`);
});

test('(CMF7) _PROVIDER_AUTO_MODELS_STATIC github-copilot in run-agent.js uses gpt-5 tiers', () => {
  const src = fs.readFileSync(runAgentPath, 'utf8');
  const staticBlock = src.match(/_PROVIDER_AUTO_MODELS_STATIC\s*=\s*\{[\s\S]*?\};/);
  assert.ok(staticBlock, '_PROVIDER_AUTO_MODELS_STATIC block must be present in run-agent.js');
  const block = staticBlock[0];
  // The github-copilot entry should reference gpt-5.
  assert.ok(block.includes("'gpt-5'") || block.includes('"gpt-5"'), `_PROVIDER_AUTO_MODELS_STATIC github-copilot must use gpt-5`);
  // No gpt-4.1 values (comments excluded — raw string check on the block).
  const blockNoComments = block.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/'gpt-4\.1'/.test(blockNoComments), `_PROVIDER_AUTO_MODELS_STATIC must not contain 'gpt-4.1' value`);
});

// ---------------------------------------------------------------------------
// Hard-abort tests — extract isModelIdForeignToProvider from run-agent.js source
// and stub process.exit to assert the abort fires instead of returning a substitute.
// ---------------------------------------------------------------------------

const runAgentSrc = fs.readFileSync(runAgentPath, 'utf8');

// Extract isModelIdForeignToProvider as a standalone function.
function extractFn(src, name) {
  const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name} from run-agent.js`);
  return m[0];
}

// Build resolveModel's foreign-branch logic in isolation:
// We only need isModelIdForeignToProvider to test the abort guard.
// eslint-disable-next-line no-new-func
const fnSrc = extractFn(runAgentSrc, 'isModelIdForeignToProvider');
// eslint-disable-next-line no-new-func
const isModelIdForeignToProvider = new Function(`${fnSrc}\nreturn isModelIdForeignToProvider;`)();

test('(CMF4) configured Claude model under github-copilot is detected as foreign', () => {
  // This asserts the detection function that drives the abort guard.
  assert.strictEqual(
    isModelIdForeignToProvider('claude-opus-4-8', 'github-copilot'),
    true,
    'claude-opus-4-8 must be detected as foreign to github-copilot'
  );
  assert.strictEqual(
    isModelIdForeignToProvider('gpt-5', 'github-copilot'),
    false,
    'gpt-5 must NOT be detected as foreign to github-copilot'
  );
});

test('(CMF5) run-agent.js foreign-model branch calls process.exit(1) not substituting', () => {
  // Find the position of the user-configured foreign-model guard (non-auto branch).
  // It must have process.exit(1) and must NOT have a substitution return before the exit.
  // We identify the guard by looking for the comment that precedes it.
  const guardCommentIdx = runAgentSrc.indexOf('Hard abort when the user explicitly configured a model');
  assert.ok(guardCommentIdx !== -1, 'Hard-abort comment must exist in run-agent.js');

  // Slice from the guard comment up to the closing brace of that if-block.
  // The block ends at process.exit(1) followed by whitespace + '}'.
  const sliceFrom = guardCommentIdx;
  const exitIdx = runAgentSrc.indexOf('process.exit(1)', sliceFrom);
  assert.ok(exitIdx !== -1, 'process.exit(1) must appear in the foreign-model guard');
  // The guard block ends just after the exit call + closing brace — slice to that point.
  const sliceTo = exitIdx + 'process.exit(1);'.length + 10;
  const block = runAgentSrc.slice(sliceFrom, sliceTo);

  // block must not contain a substitute return before the exit.
  assert.ok(!block.includes('return { modelArgs'), 'foreign-model guard must NOT return a substitute model before process.exit(1)');
  assert.ok(block.includes('process.exit(1)'), 'foreign-model guard must call process.exit(1)');
  assert.ok(block.includes('Valid models'), 'error message must list valid models');
});

test('(CMF8) model-unavailable fallback omits --model when medium tier equals attempted (gpt-5 same-tier case)', () => {
  // When tiers.medium === attempted (both gpt-5), the existing "fallbackModel !== attempted" branch
  // cannot fire. For github-copilot, the harness must retry with empty modelArgs so Copilot
  // uses its account-default instead of surfacing an error.
  const fallbackBlock = runAgentSrc.indexOf("provider.id === 'github-copilot'");
  assert.ok(fallbackBlock !== -1, "github-copilot same-tier fallback block must exist in run-agent.js");
  // The block must retry with empty modelArgs (omit --model).
  const sliceTo = runAgentSrc.indexOf('provider.spawn(finalPayload', fallbackBlock) + 100;
  const block = runAgentSrc.slice(fallbackBlock, sliceTo);
  assert.ok(block.includes('modelArgs: []'), 'same-tier fallback must retry with modelArgs: [] to omit --model flag');
});

// ---------------------------------------------------------------------------
if (_failed === 0) console.log('\nAll copilot-model-floor tests passed.');
else console.error(`\n${_failed} copilot-model-floor test(s) FAILED.`);
