#!/usr/bin/env node
'use strict';

// Regression tests for auto-model-restore bug fixes.
// Covers: (a) applyPlanningEffortAndModel writes full _harness_auto_set even when
// initial values are non-"auto"; (b) second call does not clobber with empty arrays;
// (c) restoreAutoModelFields resets roles to "auto" when originalAutoRoles is empty
// but _harness_auto_set is present on disk.
// Run: node Agent_Orchestrator/tests/auto-model-restore.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const runAgentSrc = fs.readFileSync(RUN_AGENT, 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── (a) applyPlanningEffortAndModel always writes full role lists ─────────────

test('applyPlanningEffortAndModel: no guard on model role override (unconditional assignment)', () => {
  // Old code: `if (!cur || cur === '' || cur === 'auto') { fresh.models[role] = resolvedModel; ... }`
  // New code: direct assignment without guard.
  assert.ok(
    !runAgentSrc.includes("if (!cur || cur === '' || cur === 'auto') { fresh.models[role]"),
    'guarded model assignment still present — should be unconditional'
  );
});

test('applyPlanningEffortAndModel: no guard on effort role override (unconditional assignment)', () => {
  assert.ok(
    !runAgentSrc.includes("if (!curEffort || curEffort === '' || curEffort === 'auto') { fresh['model-effort'][role]"),
    'guarded effort assignment still present — should be unconditional'
  );
});

test('applyPlanningEffortAndModel: _harness_auto_set written with stored original values (object format)', () => {
  // New format: {models: {coding: origVal, ...}, 'model-effort': {...}} — not arrays.
  // Ensures restore path recovers exact pre-planning values, not just "auto".
  assert.ok(
    runAgentSrc.includes("fresh['_harness_auto_set'] = { models: origModels, 'model-effort': origEffort }"),
    '_harness_auto_set not written with object-format originals'
  );
});

// ── (b) second call does not clobber _harness_auto_set with empty arrays ──────

test('applyPlanningEffortAndModel: no autoSetModels/autoSetEffort accumulator arrays', () => {
  // Accumulators were the source of the second-call clobber. They must not exist.
  assert.ok(!runAgentSrc.includes('const autoSetModels = [];'), 'autoSetModels accumulator still present');
  assert.ok(!runAgentSrc.includes('const autoSetEffort = [];'), 'autoSetEffort accumulator still present');
});

// ── (c) restoreAutoModelFields unions _harness_auto_set with originalAutoRoles ─

test('restoreAutoModelFields: no early-return on empty originalAutoRoles', () => {
  // Old guard: `if (originalAutoRoles.models.length === 0 && originalAutoRoles.modelEffort.length === 0) return;`
  assert.ok(
    !runAgentSrc.includes('if (originalAutoRoles.models.length === 0 && originalAutoRoles.modelEffort.length === 0) return;'),
    'early-return guard on originalAutoRoles still present in restoreAutoModelFields'
  );
});

test('restoreAutoModelFields: reads _harness_auto_set from fresh config and unions with originalAutoRoles', () => {
  assert.ok(
    runAgentSrc.includes("const stale = fresh['_harness_auto_set'] || {};"),
    '_harness_auto_set union read missing from restoreAutoModelFields'
  );
  assert.ok(
    runAgentSrc.includes('rolesToRestore'),
    'rolesToRestore Set merge missing from restoreAutoModelFields'
  );
});

test('restoreAutoModelFields: hasWork guard uses Object.keys(stale).length (precise, not truthy {})', () => {
  assert.ok(
    runAgentSrc.includes('const hasWork = rolesToRestore.models.size > 0 || rolesToRestore.modelEffort.size > 0 || Object.keys(stale).length > 0'),
    'hasWork guard missing or imprecise — {} would pass truthy check; use Object.keys().length'
  );
});

// ── integration: simulate applyPlanningEffortAndModel + restoreAutoModelFields ─

test('integration: non-"auto" initial values overridden by planning, then restored to originals (not "auto")', () => {
  const tmp = path.join(os.tmpdir(), `auto-model-restore-test-${process.pid}.json`);
  try {
    // Initial state: coding effort = "max", model = "claude-sonnet-4-6" (neither is "auto")
    const initial = { models: { coding: 'claude-sonnet-4-6', assessment: 'claude-sonnet-4-6' }, 'model-effort': { coding: 'max', assessment: 'max' } };
    fs.writeFileSync(tmp, JSON.stringify(initial, null, 2), 'utf8');

    // Simulate applyPlanningEffortAndModel: capture originals, then overwrite
    const resolvedModel = 'claude-haiku-4-5';
    const resolvedEffort = 'normal';
    const fresh = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fresh['model-effort'] = fresh['model-effort'] || {};
    fresh.models = fresh.models || {};
    const origModels = {};
    const origEffort = {};
    for (const role of ['coding', 'assessment']) {
      origModels[role] = fresh.models[role] != null ? fresh.models[role] : null;
      origEffort[role] = fresh['model-effort'][role] != null ? fresh['model-effort'][role] : null;
      fresh.models[role] = resolvedModel;
      fresh['model-effort'][role] = resolvedEffort;
    }
    fresh['_harness_auto_set'] = { models: origModels, 'model-effort': origEffort };
    fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2), 'utf8');

    // Verify override was written and originals captured
    const afterApply = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    assert.strictEqual(afterApply.models.coding, 'claude-haiku-4-5', 'model not overridden');
    assert.strictEqual(afterApply['model-effort'].coding, 'normal', 'effort not overridden');
    assert.strictEqual(afterApply['_harness_auto_set'].models.coding, 'claude-sonnet-4-6', 'original model not captured in _harness_auto_set');
    assert.strictEqual(afterApply['_harness_auto_set']['model-effort'].coding, 'max', 'original effort not captured in _harness_auto_set');

    // Simulate restoreAutoModelFields: use _staleKeys/_staleVal helpers (new format)
    const originalAutoRoles = { models: [], modelEffort: [] };
    const stale = afterApply['_harness_auto_set'] || {};
    const _staleKeys = (bag) => !bag ? [] : (Array.isArray(bag) ? bag : Object.keys(bag));
    const _staleVal = (bag, role) => !bag || Array.isArray(bag) ? 'auto' : (bag[role] != null ? bag[role] : 'auto');
    const rolesToRestore = {
      models: new Set([...(originalAutoRoles.models || []), ..._staleKeys(stale.models)]),
      modelEffort: new Set([...(originalAutoRoles.modelEffort || []), ..._staleKeys(stale['model-effort'])]),
    };
    const hasWork = rolesToRestore.models.size > 0 || rolesToRestore.modelEffort.size > 0 || Object.keys(stale).length > 0;
    assert.ok(hasWork, 'hasWork should be true when _harness_auto_set present');
    for (const role of rolesToRestore.models) afterApply.models[role] = _staleVal(stale.models, role);
    for (const role of rolesToRestore.modelEffort) afterApply['model-effort'][role] = _staleVal(stale['model-effort'], role);
    delete afterApply['_harness_auto_set'];
    fs.writeFileSync(tmp, JSON.stringify(afterApply, null, 2), 'utf8');

    const afterRestore = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    // Must restore to ORIGINAL values, not hard-coded "auto"
    assert.strictEqual(afterRestore.models.coding, 'claude-sonnet-4-6', 'model not restored to original value (was overwritten with "auto")');
    assert.strictEqual(afterRestore['model-effort'].coding, 'max', 'effort not restored to original value (was overwritten with "auto")');
    assert.ok(!afterRestore['_harness_auto_set'], '_harness_auto_set not deleted after restore');
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});
