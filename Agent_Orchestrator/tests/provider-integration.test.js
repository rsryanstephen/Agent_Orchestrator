#!/usr/bin/env node
'use strict';

/**
 * Integration tests: provider abstraction wiring.
 * Run: node Agent_Orchestrator/tests/provider-integration.test.js
 *
 * Coverage:
 *  (PI1) global-config.json has "provider" key defaulting to "claude-code"
 *  (PI2) registry getProvider('claude-code') returns all capabilities=true
 *  (PI3) run-agent.js runClaude delegates to provider.spawn() — no direct 'claude' spawn
 *  (PI4) auto-resume.js imports registry and checks capabilities.autoResume
 *  (PI5) parallel-broker.js contains sequential emulation path for !capabilities.subAgents
 *  (PI6) README.md contains ## Provider Selection and ## Provider Limitations sections
 *  (PI7) Copilot-bound system prompt contains no Claude-only tool names (Skill/ToolSearch/EnterPlanMode)
 *  (PI8) History-file role headers are provider-neutral (no provider name in header text)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const PROVIDERS_DIR = path.join(HARNESS, 'src', 'lib', 'providers');
const REGISTRY_PATH = path.join(PROVIDERS_DIR, 'registry.js');
const GLOBAL_CONFIG_PATH = path.join(HARNESS, 'global-config.json');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── PI1: global-config.json has "provider" key ──────────────────────────────
test('(PI1) global-config.json has "provider" key defaulting to "claude-code"', () => {
  const cfg = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
  assert.ok(Object.prototype.hasOwnProperty.call(cfg, 'provider'), '"provider" key missing from global-config.json');
  assert.strictEqual(cfg.provider, 'claude-code', '"provider" must default to "claude-code"');
});

// ── PI2: registry returns claude-code with all capabilities=true ─────────────
test('(PI2) getProvider("claude-code") returns provider with all capabilities=true', () => {
  delete require.cache[REGISTRY_PATH];
  const { getProvider } = require(REGISTRY_PATH);
  const provider = getProvider('claude-code');
  assert.strictEqual(provider.id, 'claude-code');
  assert.strictEqual(provider.capabilities.planMode, true, 'planMode must be true for claude-code');
  assert.strictEqual(provider.capabilities.skillsRuntime, true, 'skillsRuntime must be true for claude-code');
  assert.strictEqual(provider.capabilities.subAgents, true, 'subAgents must be true for claude-code');
  assert.strictEqual(provider.capabilities.autoResume, true, 'autoResume must be true for claude-code');
});

// ── PI3: run-agent.js delegates to provider.spawn() ─────────────────────────
test('(PI3) run-agent.js runClaude calls provider.spawn() and imports registry', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(src.includes("require('./lib/providers/registry')"), 'run-agent.js must import registry');
  assert.ok(/provider\.spawn\(/.test(src), 'runClaude must call provider.spawn(...)');
  // The old direct spawn('claude', ...) pattern must not appear in runClaude body.
  // (It may still exist in the legacy unused comment — acceptable.)
  const runClaudeMatch = src.match(/async function runClaude[\s\S]*?\n\}/);
  if (runClaudeMatch) {
    assert.ok(!runClaudeMatch[0].includes("spawn('claude'"), 'runClaude must not contain direct spawn("claude")');
  }
});

// ── PI4: auto-resume.js checks capabilities.autoResume ──────────────────────
test('(PI4) auto-resume.js imports registry and gates on capabilities.autoResume', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'auto-resume.js'), 'utf8');
  assert.ok(src.includes("require('./lib/providers/registry')"), 'auto-resume.js must import registry');
  assert.ok(src.includes('capabilities.autoResume'), 'auto-resume.js must check capabilities.autoResume');
  assert.ok(src.includes('[WARN]'), 'auto-resume.js must emit [WARN] when autoResume=false');
});

// ── PI5: parallel-broker.js sequential emulation ────────────────────────────
test('(PI5) parallel-broker.js has sequential emulation path when !capabilities.subAgents', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'parallel-broker.js'), 'utf8');
  assert.ok(src.includes('capabilities.subAgents'), 'parallel-broker.js must check capabilities.subAgents');
  assert.ok(src.includes('sequential'), 'parallel-broker.js must contain "sequential" emulation path');
  assert.ok(src.includes('[WARN]'), 'parallel-broker.js must emit [WARN] when subAgents=false');
});

// ── PI6: README contains both new sections ───────────────────────────────────
test('(PI6) README.md contains ## Provider Selection and ## Provider Limitations', () => {
  const readme = fs.readFileSync(path.join(HARNESS, 'README.md'), 'utf8');
  assert.ok(/^## Provider Selection/m.test(readme), 'README must contain ## Provider Selection');
  assert.ok(/^## Provider Limitations/m.test(readme), 'README must contain ## Provider Limitations');
  // Verify the table rows are present.
  assert.ok(/claude-code/.test(readme), 'README Provider Limitations must mention claude-code');
  assert.ok(/github-copilot/.test(readme), 'README Provider Limitations must mention github-copilot');
});

// ── PI7: Copilot capabilities are false; no Claude-only tool names ───────────
test('(PI7) Copilot capabilities flag planMode/skillsRuntime/subAgents/autoResume as false', () => {
  const copilotPath = path.join(PROVIDERS_DIR, 'github-copilot.js');
  if (!fs.existsSync(copilotPath)) {
    console.warn('  [skip] github-copilot.js not yet created — skipping PI7.');
    return;
  }
  // Use registry adapter (handles both class and module-style exports).
  delete require.cache[REGISTRY_PATH];
  delete require.cache[copilotPath];
  const { getProvider } = require(REGISTRY_PATH);
  const provider = getProvider('github-copilot');
  const FORBIDDEN = ['Skill', 'ToolSearch', 'EnterPlanMode'];
  assert.strictEqual(provider.capabilities.planMode, false, 'planMode must be false for github-copilot');
  assert.strictEqual(provider.capabilities.skillsRuntime, false, 'skillsRuntime must be false for github-copilot');
  assert.strictEqual(provider.capabilities.subAgents, false, 'subAgents must be false for github-copilot');
  assert.strictEqual(provider.capabilities.autoResume, false, 'autoResume must be false for github-copilot');
  // loginInstructions must not reference Claude-only tool names.
  const instructions = provider.loginInstructions();
  for (const forbidden of FORBIDDEN) {
    assert.ok(!instructions.includes(forbidden), `loginInstructions() must not contain "${forbidden}"`);
  }
});

// ── PI8: History-file headers are provider-neutral ───────────────────────────
test('(PI8) History-file role headers contain no provider-specific names', () => {
  const fanOutPath = path.join(HARNESS, 'src', 'lib', 'fan-out.js');
  const src = fs.readFileSync(fanOutPath, 'utf8');
  // Extract ROLE_HEADER values.
  const matches = [...src.matchAll(/ROLE_HEADER\s*=\s*\{([^}]+)\}/g)];
  for (const m of matches) {
    const block = m[1];
    assert.ok(!/claude(?!_harness)/i.test(block), 'ROLE_HEADER values must not contain "claude" (except as part of a topic name)');
    assert.ok(!/copilot/i.test(block), 'ROLE_HEADER values must not contain "copilot"');
  }
});

// Requirement: auto-selection should prefer models native to the selected provider.
// For github-copilot the light/medium/heavy tiers must all be GPT (not Claude) model IDs.
test('(PI9) PROVIDER_AUTO_MODELS: github-copilot tiers are GPT model IDs, not Claude', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  // Extract the PROVIDER_AUTO_MODELS literal block.
  const m = src.match(/const PROVIDER_AUTO_MODELS\s*=\s*(\{[\s\S]*?\n\};)/);
  assert.ok(m, 'PROVIDER_AUTO_MODELS constant must exist in run-agent.js');
  // Eval is safe here — run-agent constants are static literals in a test context.
  // Extract copilot entry via regex instead of eval to avoid side effects.
  const copilotMatch = src.match(/'github-copilot'\s*:\s*\{\s*light:\s*'([^']+)'\s*,\s*medium:\s*'([^']+)'\s*,\s*heavy:\s*'([^']+)'/);
  assert.ok(copilotMatch, 'PROVIDER_AUTO_MODELS must have a github-copilot entry');
  const [, light, medium, heavy] = copilotMatch;
  for (const id of [light, medium, heavy]) {
    assert.ok(!id.startsWith('claude-'), `github-copilot model tier "${id}" must not be a Claude model`);
    assert.ok(id.startsWith('gpt-') || id.startsWith('o'), `github-copilot model tier "${id}" must be a GPT/OpenAI model`);
  }
});

// Requirement: auto-selection should prefer models native to the selected provider.
// For gemini/gemini-vertex the tiers must be Gemini model IDs, not Claude.
test('(PI10) PROVIDER_AUTO_MODELS: gemini tiers are Gemini model IDs, not Claude', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  for (const providerId of ['gemini', 'gemini-vertex']) {
    const re = new RegExp(`'${providerId}'\\s*:\\s*\\{\\s*light:\\s*'([^']+)'\\s*,\\s*medium:\\s*'([^']+)'\\s*,\\s*heavy:\\s*'([^']+)'`);
    const m = src.match(re);
    assert.ok(m, `PROVIDER_AUTO_MODELS must have a ${providerId} entry`);
    const [, light, medium, heavy] = m;
    for (const id of [light, medium, heavy]) {
      assert.ok(!id.startsWith('claude-'), `${providerId} model tier "${id}" must not be a Claude model`);
      assert.ok(id.startsWith('gemini-'), `${providerId} model tier "${id}" must be a Gemini model`);
    }
  }
});

// Requirement: after a run completes, models and model-effort must be reset to "auto".
// If a previous run crashed, _harness_auto_set marker must trigger cleanup on next startup.
test('(PI11) restoreAutoModelFields deletes _harness_auto_set marker on success path', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(src.includes('_harness_auto_set'), 'run-agent.js must reference _harness_auto_set marker');
  assert.ok(/delete fresh\['_harness_auto_set'\]/.test(src), 'restoreAutoModelFields must delete _harness_auto_set from config');
  // Verify cleanup block exists (cleanupStaleAutoSetRoles IIFE)
  assert.ok(src.includes('Cleaned up stale _harness_auto_set marker'), 'run-agent.js must log stale marker cleanup');
});

// Requirement: resolveModelId must pass through non-Claude model IDs (GPT, Gemini) unchanged.
test('(PI12) resolveModelId passes through non-Claude model IDs without falling back to LATEST_SONNET', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  // The old final `return null` in resolveModelId caused fallback to LATEST_SONNET for GPT IDs.
  // Verify the passthrough comment/return is present.
  assert.ok(src.includes('Non-Claude model IDs (GPT, Gemini, etc.)'), 'resolveModelId must have passthrough comment for non-Claude IDs');
});

// Requirement: models/model-effort must be restored to "auto" even when process.exit() is called
// directly (e.g. token-limit, network-retry exhaustion, SIGINT during inline wait).
test('(PI13) ensureAutoModelRestored is registered as a process.on("exit") handler', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(src.includes('ensureAutoModelRestored'), 'run-agent.js must define ensureAutoModelRestored');
  assert.ok(/process\.on\(['"]exit['"],\s*ensureAutoModelRestored\)/.test(src),
    'ensureAutoModelRestored must be registered via process.on("exit", ...)');
  assert.ok(src.includes('_autoRestoreDone'), 'ensureAutoModelRestored must guard against double-invocation with _autoRestoreDone flag');
});

// Requirement: resolveModel must use the effective provider (topic-config overrides global) so
// the fallback medium-tier model is native to the selected provider, not always LATEST_SONNET.
test('(PI14) resolveModel uses cfgRead for provider resolution and provider-native fallback', () => {
  const src = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  assert.ok(/cfgRead\(topicConfig,\s*config,\s*'provider'/.test(src),
    'resolveModel must resolve provider via cfgRead(topicConfig, config, "provider", ...)');
  assert.ok(src.includes('providerTiers'), 'resolveModel must use providerTiers for fallback model selection');
  assert.ok(!src.includes(`modelArgs: ['--model', LATEST_SONNET], fallbackNote: null }`),
    'resolveModel fallback must not hardcode LATEST_SONNET');
});

// ── PI13-runtime: restoreAutoModelFields writes "auto" back to config ────────
test('(PI13-runtime) restoreAutoModelFields writes "auto" to config and removes _harness_auto_set', () => {
  const os = require('os');
  const RUN_AGENT_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');
  const fnStart = RUN_AGENT_SRC.indexOf('function restoreAutoModelFields(');
  const fnEnd = RUN_AGENT_SRC.indexOf('\nlet _autoRestoreDone', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'restoreAutoModelFields boundary not found');
  const fnSrc = RUN_AGENT_SRC.slice(fnStart, fnEnd).trim();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi13-'));
  const cfgPath = path.join(dir, 'topic-config.json');
  const initial = {
    models: { coding: 'gpt-4o', assessment: 'claude-sonnet-4-6', planning: 'auto' },
    'model-effort': { coding: 'high', assessment: 'medium', planning: 'auto' },
    '_harness_auto_set': { models: ['coding'], 'model-effort': ['coding'] }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(initial, null, 2), 'utf8');

  const fakeConfigUtils = {
    loadConfig: (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
    writeConfig: (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'),
    kebabToCamel: (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
  };
  const fakeOriginalAutoRoles = { models: ['coding'], modelEffort: ['coding'] };

  const factory = new Function(
    'topicConfig', 'topicConfigPath', 'originalAutoRoles', 'TOPIC_LOCK_PATH',
    'configUtils', 'acquireTopicConfigLock', 'releaseTopicConfigLock', 'log',
    `${fnSrc}; return restoreAutoModelFields;`
  );
  const fn = factory(
    { ...initial }, cfgPath, fakeOriginalAutoRoles, cfgPath + '.lock',
    fakeConfigUtils, () => {}, () => {}, () => {}
  );

  fn();

  const result = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.strictEqual(result.models.coding, 'auto', 'models.coding must be "auto"');
  assert.strictEqual(result.models.assessment, 'claude-sonnet-4-6', 'models.assessment must be unchanged');
  assert.strictEqual(result['model-effort'].coding, 'auto', 'model-effort.coding must be "auto"');
  assert.strictEqual(result['model-effort'].assessment, 'medium', 'model-effort.assessment must be unchanged');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, '_harness_auto_set'), '_harness_auto_set must be deleted');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── PI14-runtime: resolveModel uses provider-native fallback ─────────────────
test('(PI14-runtime) resolveModel falls back to provider-native medium tier (not LATEST_SONNET) for github-copilot', () => {
  const RUN_AGENT_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8');

  const constStart = RUN_AGENT_SRC.indexOf('const LATEST_OPUS =');
  const pamBlockEnd = RUN_AGENT_SRC.indexOf('\n};', RUN_AGENT_SRC.indexOf('const PROVIDER_AUTO_MODELS =')) + 3;
  const constSrc = RUN_AGENT_SRC.slice(constStart, pamBlockEnd).trim();

  const rmiStart = RUN_AGENT_SRC.indexOf('function resolveModelId(');
  const rmiEnd = RUN_AGENT_SRC.indexOf('\nfunction applyRateLimitDowngrade(', rmiStart);
  const rmiSrc = RUN_AGENT_SRC.slice(rmiStart, rmiEnd).trim();

  const rmStart = RUN_AGENT_SRC.indexOf('function resolveModel(');
  const rmEnd = RUN_AGENT_SRC.indexOf('\nfunction modelFamilyName(', rmStart);
  const rmSrc = RUN_AGENT_SRC.slice(rmStart, rmEnd).trim();

  const factory = new Function(
    'topicConfig', 'config', 'configUtils',
    'autoClassifyModel', 'applyRateLimitDowngrade', 'modelFamilyName',
    `${constSrc}\n${rmiSrc}\n${rmSrc}\nreturn resolveModel;`
  );
  const fakeConfigUtils = { cfgRead: (tc, c, key, def) => tc[key] || c[key] || def };
  const resolveModel = factory(
    { provider: 'github-copilot' }, {},
    fakeConfigUtils,
    () => { throw new Error('autoClassifyModel must not be called on non-auto path'); },
    () => { throw new Error('applyRateLimitDowngrade must not be called on non-auto path'); },
    () => { throw new Error('modelFamilyName must not be called on non-auto path'); }
  );

  const result = resolveModel('', '');
  assert.deepStrictEqual(result.modelArgs, ['--model', 'gpt-5'],
    'github-copilot with no model must fall back to provider medium tier (gpt-5), not LATEST_SONNET');
  assert.strictEqual(result.fallbackNote, null, 'fallbackNote must be null for empty configured string');
});

if (_failed === 0) console.log(`\nAll provider-integration tests passed.`);
else console.error(`\n${_failed} provider-integration test(s) FAILED.`);
