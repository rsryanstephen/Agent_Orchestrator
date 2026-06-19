#!/usr/bin/env node
'use strict';

// Verifies fetchClaudeModels sends the x-api-key header when ANTHROPIC_API_KEY
// is set, and throws early (no HTTP call) when it is absent — matching the
// fetchGeminiModels guard pattern so the caller falls through to static tiers
// without the 401 noise that previously appeared in CLI output.

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lib', 'model-catalog.js'),
  'utf8',
);

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

test('fetchClaudeModels throws early when ANTHROPIC_API_KEY is unset', () => {
  const pat = /fetchClaudeModels[\s\S]{0,400}?ANTHROPIC_API_KEY[\s\S]{0,200}?throw\s+new\s+Error/;
  assert.ok(pat.test(SRC), 'expected early-throw guard on missing ANTHROPIC_API_KEY');
});

test('fetchClaudeModels sends x-api-key header when key is present', () => {
  const pat = /fetchClaudeModels[\s\S]{0,600}?['"]x-api-key['"]\s*:/;
  assert.ok(pat.test(SRC), 'expected x-api-key header in the httpsGet call');
});

test('resolveProviderTiers gates the live-fetch-failed warn behind MODEL_CATALOG_DEBUG', () => {
  const pat = /MODEL_CATALOG_DEBUG[\s\S]{0,200}?console\.warn[\s\S]{0,200}?live fetch failed/;
  assert.ok(pat.test(SRC), 'expected MODEL_CATALOG_DEBUG gate around the live-fetch-failed warn');
});

if (_failed > 0) process.exit(1);
