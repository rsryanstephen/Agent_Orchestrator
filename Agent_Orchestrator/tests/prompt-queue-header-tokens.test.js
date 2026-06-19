#!/usr/bin/env node
'use strict';

// Regression tests for the multi-token queue-header tokenizer in
// `src/prompt-queue.js`. Covers family keywords (`opus`, `sonnet`, `haiku`,
// `gpt`, `gemini`, `flash`, `pro`), exact model ids (`gpt-4.1`,
// `claude-opus-4-7`), the `(hold)` flag in any position, family→provider
// mapping, and precedence when an exact id and a family keyword coexist.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
// Force the cache to a temp file so the test does not depend on the user's
// real catalog cache — family-keyword resolution then falls through to the
// keyword-as-id path, which is what we assert against here.
process.env.MODEL_CATALOG_CACHE_PATH = path.join(os.tmpdir(), `pq-hdr-test-cache-${process.pid}.json`);
try { fs.unlinkSync(process.env.MODEL_CATALOG_CACHE_PATH); } catch {}

const promptQueue = require(path.join(HARNESS, 'src', 'prompt-queue.js'));

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pq-hdr-')); }
function writeQueue(d, txt) { fs.writeFileSync(path.join(d, 'prompt-queue.md'), txt, 'utf8'); }

// ── Family keywords map to the expected provider ───────────────────────────
test('family keyword `opus` -> claude-code', () => {
  const d = tmpdir();
  writeQueue(d, 'opus caf\nBody A\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].model, 'opus');
  assert.strictEqual(blocks[0].body.trim(), 'Body A');
});

// Spec: bare `opus` alone (no pipeline shorthand) must be recognised as a
// model-only header so the block targets claude-code with Opus-tier resolution.
test('bare `opus` standalone (no pipeline) -> model-only header, provider=claude-code, pipeline=null', () => {
  const d = tmpdir();
  writeQueue(d, 'opus\nDo the thing\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].model, 'opus');
  assert.strictEqual(blocks[0].pipeline, null);
  assert.ok(blocks[0].headerForm !== null, 'headerForm must not be null — line must be parsed as a header');
  assert.strictEqual(blocks[0].body.trim(), 'Do the thing');
});

// Spec: `Opus` (title-case) must behave identically to lowercase `opus`.
test('title-case `Opus` standalone -> same as lowercase opus (case-insensitive)', () => {
  const d = tmpdir();
  writeQueue(d, 'Opus\nDo the thing\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].model, 'opus');
  assert.strictEqual(blocks[0].pipeline, null);
  assert.ok(blocks[0].headerForm !== null, 'headerForm must not be null — Opus must parse as a header');
  assert.strictEqual(blocks[0].body.trim(), 'Do the thing');
});

test('family keyword `sonnet` standalone -> claude-code, default pipeline applies on dequeue', () => {
  const d = tmpdir();
  writeQueue(d, 'sonnet\nBody S\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].model, 'sonnet');
  assert.strictEqual(blocks[0].pipeline, null);
});

test('family keyword `gpt` -> github-copilot', () => {
  const d = tmpdir();
  writeQueue(d, 'gpt caf\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].model, 'gpt');
});

test('family keyword `flash` -> gemini', () => {
  const d = tmpdir();
  writeQueue(d, 'flash all\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'gemini');
  assert.strictEqual(blocks[0].model, 'flash');
});

test('family keyword `pro` -> gemini', () => {
  const d = tmpdir();
  writeQueue(d, 'pro caf\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'gemini');
  assert.strictEqual(blocks[0].model, 'pro');
});

// ── Exact model ids ────────────────────────────────────────────────────────
test('exact id `gpt-4.1` -> github-copilot, id preserved verbatim', () => {
  const d = tmpdir();
  writeQueue(d, 'gpt-4.1 caf\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].model, 'gpt-4.1');
  assert.strictEqual(blocks[0].pipeline, 'caf');
});

test('exact id `claude-opus-4-7` -> claude-code', () => {
  const d = tmpdir();
  writeQueue(d, 'claude-opus-4-7 all\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].model, 'claude-opus-4-7');
});

test('exact id `gemini-2.5-pro` -> gemini', () => {
  const d = tmpdir();
  writeQueue(d, 'gemini-2.5-pro caf\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'gemini');
  assert.strictEqual(blocks[0].model, 'gemini-2.5-pro');
});

// ── (hold) interleaving in any position ────────────────────────────────────
test('`(hold) opus caf` parses with held=true, pipeline=caf, provider=claude-code', () => {
  const d = tmpdir();
  writeQueue(d, '(hold) opus caf\nBody H\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].held, true);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].model, 'opus');
});

test('`caf opus (hold)` — `(hold)` at line end still flags held', () => {
  const d = tmpdir();
  writeQueue(d, 'caf opus (hold)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].held, true);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'opus');
});

// ── Precedence: exact id wins when both forms appear ───────────────────────
test('exact id wins over family keyword on the same header line', () => {
  const d = tmpdir();
  writeQueue(d, 'opus gpt-4.1 caf\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  // Last model token sets model+provider — exact `gpt-4.1` overrides
  // earlier `opus` so the block targets github-copilot.
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].model, 'gpt-4.1');
});

// ── Pipeline: form coexists with model token ───────────────────────────────
test('`Pipeline: caf` + trailing `opus` resolves both', () => {
  const d = tmpdir();
  writeQueue(d, 'Pipeline: caf opus\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'opus');
  assert.strictEqual(blocks[0].provider, 'claude-code');
});

// ── Non-header lines fall through to body ──────────────────────────────────
test('first line with unknown token treated as body (no model/provider)', () => {
  const d = tmpdir();
  writeQueue(d, 'Implement the foo feature\nMore body\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, null);
  assert.strictEqual(blocks[0].model, null);
  assert.strictEqual(blocks[0].provider, null);
  assert.ok(blocks[0].body.includes('Implement the foo'));
});

// ── Pre-existing behaviour preserved ───────────────────────────────────────
test('bare shorthand `caf` alone still parses (back-compat)', () => {
  const d = tmpdir();
  writeQueue(d, 'caf\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, null);
  assert.strictEqual(blocks[0].provider, null);
});

// ── Bare provider tokens (no family / no exact id) ─────────────────────────
test('bare provider `github-copilot` -> provider set, model null, header recognised', () => {
  const d = tmpdir();
  writeQueue(d, 'github-copilot\nBody GC\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].model, null);
  assert.strictEqual(blocks[0].pipeline, null);
  assert.strictEqual(blocks[0].body.trim(), 'Body GC');
});

test('bare provider `claude-code` with shorthand `caf` -> provider+pipeline both set', () => {
  const d = tmpdir();
  writeQueue(d, 'claude-code caf\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, null);
});

test('bare provider `gemini-vertex` recognised', () => {
  const d = tmpdir();
  writeQueue(d, 'gemini-vertex\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'gemini-vertex');
});

// ── Family + bare version fragment fold into concrete id ──────────────────
test('`opus 4.6` -> claude-opus-4-6 on claude-code', () => {
  const d = tmpdir();
  writeQueue(d, 'opus 4.6\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].model, 'claude-opus-4-6');
});

test('`sonnet 4.5 caf` -> claude-sonnet-4-5 + pipeline caf', () => {
  const d = tmpdir();
  writeQueue(d, 'sonnet 4.5 caf\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'claude-code');
  assert.strictEqual(blocks[0].model, 'claude-sonnet-4-5');
  assert.strictEqual(blocks[0].pipeline, 'caf');
});

test('`gpt 5.1` -> gpt-5.1 on github-copilot (dot preserved)', () => {
  const d = tmpdir();
  writeQueue(d, 'gpt 5.1\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].model, 'gpt-5.1');
});

test('`pro 2.5` -> gemini-2.5-pro on gemini', () => {
  const d = tmpdir();
  writeQueue(d, 'pro 2.5\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].provider, 'gemini');
  assert.strictEqual(blocks[0].model, 'gemini-2.5-pro');
});

// ── Lenient parse: unknown tokens ignored when multi-signal classifies ────
test('lenient: `opus xyz caf` -> header recognised, xyz ignored, body preserved', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('opus xyz caf\n\nbody', list);
  assert.notStrictEqual(r.headerForm, null);
  assert.strictEqual(r.pipeline, 'caf');
  assert.strictEqual(r.model, 'opus');
  assert.strictEqual(r.body.trim(), 'body');
});

test('lenient: `opus (hold)` -> single-token strict header, body has no opus/hold', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('opus (hold)\n\nI want a fallback', list);
  assert.notStrictEqual(r.headerForm, null);
  assert.strictEqual(r.held, true);
  assert.strictEqual(r.model, 'opus');
  assert.ok(!/\bopus\b/i.test(r.body));
  assert.ok(!/hold/i.test(r.body));
  assert.ok(r.body.includes('I want a fallback'));
});

test('lenient: prose line `Fable is a great model` NOT eaten as header', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('Fable is a great model\n\nbody', list);
  assert.strictEqual(r.headerForm, null);
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.provider, null);
  assert.ok(r.body.includes('Fable is a great model'));
});

test('lenient: unrecognised-token warn emitted once via log callback', () => {
  const list = promptQueue.readShorthandList();
  const warnings = [];
  const r = promptQueue.parseBlock('opus xyz caf\n\nbody', list, { log: m => warnings.push(m) });
  assert.notStrictEqual(r.headerForm, null);
  assert.strictEqual(warnings.length, 1);
  assert.ok(/unrecognised header token/i.test(warnings[0]));
  assert.ok(/xyz/.test(warnings[0]));
});

test('lenient: `opus typo` (single classified vs single unknown) -> header recognised', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('opus typo\n\nbody', list);
  assert.notStrictEqual(r.headerForm, null);
  assert.strictEqual(r.model, 'opus');
  assert.strictEqual(r.body.trim(), 'body');
});

// ── (model=X) and (provider=X) key-value overrides ───────────────────────
test('`Pipeline: caf (model=gpt-5.4)` -> pipeline=caf, model=gpt-5.4, provider=github-copilot', () => {
  const d = tmpdir();
  writeQueue(d, 'Pipeline: caf (model=gpt-5.4)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'gpt-5.4');
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].body.trim(), 'Body');
});

test('`pcaf (model=gpt-5.4)` -> pipeline=pcaf, model=gpt-5.4, provider=github-copilot', () => {
  const d = tmpdir();
  writeQueue(d, 'pcaf (model=gpt-5.4)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'pcaf');
  assert.strictEqual(blocks[0].model, 'gpt-5.4');
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].body.trim(), 'Body');
});

test('`Pipeline: caf (provider=github-copilot)` -> pipeline=caf, provider=github-copilot, model=null', () => {
  const d = tmpdir();
  writeQueue(d, 'Pipeline: caf (provider=github-copilot)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].model, null);
  assert.strictEqual(blocks[0].body.trim(), 'Body');
});

test('`pcaf (provider=github-copilot)` -> pipeline=pcaf, provider=github-copilot, model=null', () => {
  const d = tmpdir();
  writeQueue(d, 'pcaf (provider=github-copilot)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'pcaf');
  assert.strictEqual(blocks[0].provider, 'github-copilot');
  assert.strictEqual(blocks[0].model, null);
  assert.strictEqual(blocks[0].body.trim(), 'Body');
});

test('`Pipeline: caf (model=claude-sonnet-4-6)` -> provider inferred as claude-code', () => {
  const d = tmpdir();
  writeQueue(d, 'Pipeline: caf (model=claude-sonnet-4-6)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'claude-sonnet-4-6');
  assert.strictEqual(blocks[0].provider, 'claude-code');
});

test('`caf (model=gemini-2.5-pro)` -> provider inferred as gemini', () => {
  const d = tmpdir();
  writeQueue(d, 'caf (model=gemini-2.5-pro)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'gemini-2.5-pro');
  assert.strictEqual(blocks[0].provider, 'gemini');
});

test('`caf (model=gpt-5.4) (provider=gemini-vertex)` -> explicit provider overrides inferred', () => {
  const d = tmpdir();
  writeQueue(d, 'caf (model=gpt-5.4) (provider=gemini-vertex)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'gpt-5.4');
  assert.strictEqual(blocks[0].provider, 'gemini-vertex');
});

test('KV model override does not leak into body', () => {
  const d = tmpdir();
  writeQueue(d, 'caf (model=gpt-5.4)\nDo the thing\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.ok(!blocks[0].body.includes('model='), 'KV token must not appear in body');
  assert.strictEqual(blocks[0].body.trim(), 'Do the thing');
});

test('KV model override coexists with (hold)', () => {
  const d = tmpdir();
  writeQueue(d, 'caf (hold) (model=gpt-5.4)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].held, true);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'gpt-5.4');
  assert.strictEqual(blocks[0].provider, 'github-copilot');
});

// ── kv-only header (no shorthand, no family keyword) ─────────────────────
// Assessment gap: the `kv-only` headerForm path (prompt-queue.js:457) fires when
// the only content on the header line is a (model=X)/(provider=X) parenthetical.
// Verify that both model+provider are set correctly and body is preserved.
test('`(model=gpt-5.4)` alone (kv-only) -> model=gpt-5.4, provider=github-copilot, pipeline=null', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('(model=gpt-5.4)\nDo the thing\n', list);
  assert.strictEqual(r.headerForm, 'kv-only', 'must be classified kv-only');
  assert.strictEqual(r.model, 'gpt-5.4');
  assert.strictEqual(r.provider, 'github-copilot');
  assert.strictEqual(r.pipeline, null);
  assert.ok(!r.body.includes('model='), 'KV must not appear in body');
  assert.ok(r.body.trim() === 'Do the thing');
});

test('`(model=claude-sonnet-4-6)` alone (kv-only) -> model set, provider=claude-code, pipeline=null', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('(model=claude-sonnet-4-6)\nBody\n', list);
  assert.strictEqual(r.headerForm, 'kv-only');
  assert.strictEqual(r.model, 'claude-sonnet-4-6');
  assert.strictEqual(r.provider, 'claude-code');
  assert.strictEqual(r.pipeline, null);
});

test('`(provider=github-copilot)` alone (provider-only KV) -> provider set, model=null, pipeline=null', () => {
  const list = promptQueue.readShorthandList();
  const r = promptQueue.parseBlock('(provider=github-copilot)\nBody\n', list);
  assert.ok(r.headerForm !== null, 'must be recognised as a header');
  assert.strictEqual(r.provider, 'github-copilot');
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.pipeline, null);
  assert.ok(!r.body.includes('provider='), 'KV must not appear in body');
});

// ── KV overrides family-resolved model AND provider ────────────────────────
// When a family keyword (e.g. `opus` → claude-code) appears alongside a KV
// model override, the KV must win for BOTH model and provider fields so the
// block is routed to the correct provider.
test('`opus caf (model=gpt-5.4)` -> KV overrides family: model=gpt-5.4, provider=github-copilot', () => {
  const d = tmpdir();
  writeQueue(d, 'opus caf (model=gpt-5.4)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'gpt-5.4', 'KV model must override opus');
  assert.strictEqual(blocks[0].provider, 'github-copilot', 'provider must be inferred from gpt-5.4, not opus');
  assert.strictEqual(blocks[0].body.trim(), 'Body');
});

test('`Pipeline: caf opus (model=gpt-5.4)` -> KV overrides family token on Pipeline: line', () => {
  const d = tmpdir();
  writeQueue(d, 'Pipeline: caf opus (model=gpt-5.4)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].pipeline, 'caf');
  assert.strictEqual(blocks[0].model, 'gpt-5.4');
  assert.strictEqual(blocks[0].provider, 'github-copilot');
});

// ── Unrecognised model id: provider behaviour documented ──────────────────
// When (model=X) carries an id whose prefix isn't recognized, providerForExactModel
// returns null — the family-keyword-resolved provider is preserved (not cleared).
// This is intentional: user supplied a custom model id but did not specify (provider=X),
// so the family keyword's provider remains as the best guess.
test('`opus caf (model=my-custom-model)` -> unrecognised id, provider preserved from opus (claude-code)', () => {
  const d = tmpdir();
  writeQueue(d, 'opus caf (model=my-custom-model)\nBody\n');
  const { blocks } = promptQueue.parseQueue(d);
  assert.strictEqual(blocks[0].model, 'my-custom-model');
  assert.strictEqual(blocks[0].provider, 'claude-code', 'family-resolved provider must survive when KV model id is unrecognised');
});

if (_failed === 0) console.log('\nAll header-token tests passed.');
else { console.error(`\n${_failed} test(s) FAILED.`); process.exit(1); }
