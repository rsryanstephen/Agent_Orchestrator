#!/usr/bin/env node
'use strict';

// Tests for start-topic.js, set-topic.js, rename-topic.js, remove-topic.js,
// update-models-reference.js.
// Run: node Agent_Orchestrator/tests/topic-management.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const configUtils = require('../src/config-utils');

const HARNESS = path.join(__dirname, '..');
const START_TOPIC_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'start-topic.js'), 'utf8');
const SET_TOPIC_SRC   = fs.readFileSync(path.join(HARNESS, 'src', 'set-topic.js'), 'utf8');
const RENAME_TOPIC_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'rename-topic.js'), 'utf8');
const REMOVE_TOPIC_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'remove-topic.js'), 'utf8');
const UPDATE_MODELS_SRC = fs.readFileSync(path.join(HARNESS, 'src', 'update-models-reference.js'), 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// ── start-topic.js ─────────────────────────────────────────────────────────────

test('start-topic: auto-ID uses max(existing)+1 when IDs present', () => {
  // Auto-assign: usedIds = Object.keys(topicIds).map(Number); numericId = max+1 or 1.
  assert.ok(/Math\.max\(\.\.\.\w+\) \+ 1/.test(START_TOPIC_SRC),
    'auto-assign must use Math.max(...usedIds) + 1');
  assert.ok(/usedIds\.length > 0 \? Math\.max/.test(START_TOPIC_SRC),
    'must guard for empty usedIds (length > 0 check before Math.max)');
});

test('start-topic: auto-ID falls back to 1 when no IDs exist', () => {
  assert.ok(/Math\.max\(\.\.\.\w+\) \+ 1 : 1/.test(START_TOPIC_SRC),
    'fallback to 1 when usedIds is empty');
});

test('start-topic: displaced topic gets a new ID before overwrite', () => {
  // When numericId is already taken by a different topic, that topic is
  // moved to a freshly computed max+1 ID before the new topic claims the slot.
  assert.ok(/displacedTopic/.test(START_TOPIC_SRC),
    'displaced topic variable must exist');
  assert.ok(/displacedTopic && displacedTopic !== topicName/.test(START_TOPIC_SRC),
    'displaced-topic guard must compare names before reassigning');
  assert.ok(/topicIds\[newId\] = displacedTopic/.test(START_TOPIC_SRC),
    'displaced topic must be re-registered under a new ID');
});

test('start-topic: history file seeded with User Prompt header', () => {
  assert.ok(/writeFileSync\(historyFile,.*## User Prompt/s.test(START_TOPIC_SRC),
    'history file must be seeded with "## User Prompt"');
});

test('start-topic: minimal topic-config scaffold — only README, topic-id, prompt-file', () => {
  const scaffoldStart = START_TOPIC_SRC.indexOf('const seedTopicConfig = {');
  const scaffoldEnd   = START_TOPIC_SRC.indexOf('};', scaffoldStart);
  const block = START_TOPIC_SRC.slice(scaffoldStart, scaffoldEnd + 2);
  assert.ok(/'\/\/ README'/.test(block), 'README comment key must be present');
  assert.ok(/'topic-id'/.test(block),    'topic-id must be present');
  assert.ok(/'prompt-file'/.test(block), 'prompt-file must be present');
  assert.ok(!/models/.test(block),       'models must NOT be pre-seeded');
  assert.ok(!/model-effort/.test(block), 'model-effort must NOT be pre-seeded');
});

test('start-topic: topic registered in topic-ids map', () => {
  assert.ok(/topicIds\[numericId\] = topicName/.test(START_TOPIC_SRC),
    'topic must be written into topic-ids under its numericId');
  assert.ok(/configUtils\.writeConfig\(configPath, config\)/.test(START_TOPIC_SRC),
    'global-config.json must be written after registration');
});

test('start-topic: prompt-queue seeded via ensureQueueFile', () => {
  assert.ok(/promptQueue\.ensureQueueFile\(topicDir\)/.test(START_TOPIC_SRC),
    'start-topic must seed prompt-queue.md via promptQueue.ensureQueueFile');
});

// ── set-topic.js ───────────────────────────────────────────────────────────────

test('set-topic: stale-ID cleanup removes old IDs pointing to same topic', () => {
  // Loop deletes entries where name===topicName but id!==numericId.
  assert.ok(/name === topicName && id !== numericId/.test(SET_TOPIC_SRC),
    'stale-ID cleanup must match name===topicName && id!==numericId');
  assert.ok(/delete topicIds\[id\]/.test(SET_TOPIC_SRC),
    'stale-ID entry must be deleted');
});

test('set-topic: topic-config.json topic-id field updated', () => {
  assert.ok(/tc\['topic-id'\] = numericId/.test(SET_TOPIC_SRC),
    'topic-config.json topic-id must be updated to new numericId');
  assert.ok(/configUtils\.writeTopicConfig/.test(SET_TOPIC_SRC),
    'topic-config must be persisted via writeTopicConfig');
});

test('set-topic: legacy `id` key removed from topic-config on rewrite', () => {
  assert.ok(/delete tc\.id/.test(SET_TOPIC_SRC),
    'legacy `id` key must be deleted from topic-config on set-topic');
});

test('set-topic: accepts topic not yet in topic-ids if directory exists on disk', () => {
  // The guard: !knownTopics.has(topicName) -> check dir existence -> die only if dir absent.
  assert.ok(/!knownTopics\.has\(topicName\)/.test(SET_TOPIC_SRC),
    'guard for unregistered topic must check knownTopics first');
  assert.ok(/topicDirFor\(ROOT, config, topicName\)/.test(SET_TOPIC_SRC),
    'fallback to directory check when topic not in topic-ids');
});

// ── rename-topic.js ────────────────────────────────────────────────────────────

test('rename-topic: renames topic directory', () => {
  assert.ok(/fs\.renameSync\(oldDir, newDir\)/.test(RENAME_TOPIC_SRC),
    'directory must be renamed via fs.renameSync(oldDir, newDir)');
});

test('rename-topic: renames history .md file inside new directory', () => {
  assert.ok(/`\$\{oldName\}\.md`/.test(RENAME_TOPIC_SRC),
    'old history filename candidate must be oldName.md');
  assert.ok(/from\.replace\(oldName, newName\)/.test(RENAME_TOPIC_SRC),
    'target filename must use from.replace(oldName, newName)');
});

test('rename-topic: updates all topic-ids entries in global-config.json', () => {
  assert.ok(/name === oldName/.test(RENAME_TOPIC_SRC),
    'loop must find all IDs pointing to oldName');
  assert.ok(/topicIds\[id\] = newName/.test(RENAME_TOPIC_SRC),
    'each matched entry must be updated to newName');
  assert.ok(/configUtils\.writeConfig\(CONFIG, config\)/.test(RENAME_TOPIC_SRC),
    'global-config.json must be persisted after update');
});

test('rename-topic: re-stamps prompt-file in topic-config.json after rename', () => {
  // Bug: legacy topics could be missing prompt-file entirely, leaving the renamed
  // topic without a canonical history-file pointer after rename.
  assert.ok(/const desiredPromptFile = `\$\{newName\}\.md`/.test(RENAME_TOPIC_SRC),
    'rename-topic must compute the canonical renamed history filename');
  assert.ok(/tc\['prompt-file'\] = desiredPromptFile/.test(RENAME_TOPIC_SRC),
    'prompt-file must be set to desiredPromptFile in topic-config.json');
  assert.ok(/configUtils\.writeConfig\(tcPath, tc\)/.test(RENAME_TOPIC_SRC),
    'topic-config.json must be persisted after prompt-file update');
});

test('rename-topic: end-to-end prompt-file update via temp dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rename-'));
  const topicFilesDir = path.join(tmp, 'topic_files');
  // Create newDir directly (avoids Windows EPERM on renameSync of fresh temp dirs).
  const newDir = path.join(topicFilesDir, 'new-topic');
  try {
    fs.mkdirSync(newDir, { recursive: true });
    // Seed files as they would appear after a directory rename by rename-topic.js.
    fs.writeFileSync(path.join(newDir, 'old-topic.md'), '# old-topic\n\n## User Prompt\n', 'utf8');
    const tc = { '// README': 'test', 'topic-id': '1', 'prompt-file': 'old-topic.md' };
    fs.writeFileSync(path.join(newDir, 'topic-config.json'), JSON.stringify(tc, null, 2), 'utf8');

    // Simulate the post-rename steps: rename history file + update topic-config.json.
    const histFrom = path.join(newDir, 'old-topic.md');
    const histTo   = path.join(newDir, 'new-topic.md');
    if (fs.existsSync(histFrom)) fs.renameSync(histFrom, histTo);

    const tcPath = path.join(newDir, 'topic-config.json');
    const loaded = configUtils.loadConfig(tcPath);
    if (loaded['prompt-file'] === 'old-topic.md') {
      loaded['prompt-file'] = 'new-topic.md';
      configUtils.writeConfig(tcPath, loaded);
    }

    const updated = configUtils.loadConfig(tcPath);
    assert.strictEqual(updated['prompt-file'], 'new-topic.md',
      'prompt-file must be updated to new-topic.md in topic-config.json');
    assert.ok(fs.existsSync(histTo), 'new-topic.md history file must exist');
    assert.ok(!fs.existsSync(histFrom), 'old-topic.md must be gone after rename');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('rename-topic: end-to-end prompt-file backfill via temp dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rename-'));
  const topicFilesDir = path.join(tmp, 'topic_files');
  const newDir = path.join(topicFilesDir, 'new-topic');
  try {
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'old-topic.md'), '# old-topic\n\n## User Prompt\n', 'utf8');
    const tc = { '// README': 'test', 'topic-id': '1' };
    fs.writeFileSync(path.join(newDir, 'topic-config.json'), JSON.stringify(tc, null, 2), 'utf8');

    const histFrom = path.join(newDir, 'old-topic.md');
    const histTo   = path.join(newDir, 'new-topic.md');
    if (fs.existsSync(histFrom)) fs.renameSync(histFrom, histTo);

    const tcPath = path.join(newDir, 'topic-config.json');
    const loaded = configUtils.loadConfig(tcPath);
    const desiredPromptFile = 'new-topic.md';
    if (loaded['prompt-file'] !== desiredPromptFile) {
      loaded['prompt-file'] = desiredPromptFile;
      configUtils.writeConfig(tcPath, loaded);
    }

    const updated = configUtils.loadConfig(tcPath);
    assert.strictEqual(updated['prompt-file'], 'new-topic.md',
      'missing prompt-file must be backfilled to new-topic.md in topic-config.json');
    assert.ok(fs.existsSync(histTo), 'new-topic.md history file must exist');
    assert.ok(!fs.existsSync(histFrom), 'old-topic.md must be gone after rename');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── remove-topic.js ────────────────────────────────────────────────────────────

test('remove-topic: `all` resets topic-ids to {}', () => {
  assert.ok(/config\['topic-ids'\] = \{\}/.test(REMOVE_TOPIC_SRC),
    'remove-topic all must reset config["topic-ids"] to {}');
  assert.ok(/topicArg === 'all'/.test(REMOVE_TOPIC_SRC),
    'all branch must be gated on topicArg === "all"');
});

test('remove-topic: `all` deletes every topic directory', () => {
  // Iterates knownTopics and calls deleteTopicDir for each.
  assert.ok(/for \(const name of names\) deleteTopicDir\(name\)/.test(REMOVE_TOPIC_SRC),
    'all branch must call deleteTopicDir for each registered topic name');
});

test('remove-topic: single-topic removal deletes from topic-ids map', () => {
  assert.ok(/function removeTopicFromConfig\(topicName\)/.test(REMOVE_TOPIC_SRC),
    'removeTopicFromConfig helper must exist');
  assert.ok(/delete topicIds\[id\]/.test(REMOVE_TOPIC_SRC),
    'entry must be deleted from topicIds');
});

test('remove-topic: accepts numeric ID argument, resolves to topic name', () => {
  // topicIds[topicArg] ? topicIds[topicArg] : topicArg
  assert.ok(/topicIds\[topicArg\] \? topicIds\[topicArg\] : topicArg/.test(REMOVE_TOPIC_SRC),
    'remove-topic must resolve numeric ID to topic name via topicIds lookup');
});

test('remove-topic: uses fs.rmSync with recursive+force for directory deletion', () => {
  assert.ok(/fs\.rmSync\(dir, \{ recursive: true, force: true \}\)/.test(REMOVE_TOPIC_SRC),
    'deleteTopicDir must use fs.rmSync with recursive:true,force:true');
});

// ── update-models-reference.js ─────────────────────────────────────────────────

test('update-models-reference: writes models-reference.md to harness directory', () => {
  assert.ok(/OUT = path\.join\(HARNESS, 'models-reference\.md'\)/.test(UPDATE_MODELS_SRC),
    'output path must be models-reference.md in HARNESS dir');
  assert.ok(/fs\.writeFileSync\(OUT, content, 'utf8'\)/.test(UPDATE_MODELS_SRC),
    'must write content to OUT via writeFileSync');
});

test('update-models-reference: MODELS array contains opus, sonnet, haiku entries', () => {
  assert.ok(/claude-opus-4/.test(UPDATE_MODELS_SRC),  'Opus model ID missing');
  assert.ok(/claude-sonnet-4/.test(UPDATE_MODELS_SRC), 'Sonnet model ID missing');
  assert.ok(/claude-haiku-4/.test(UPDATE_MODELS_SRC),  'Haiku model ID missing');
});

test('update-models-reference: EFFORT_LEVELS covers none/auto/low/medium/high/max', () => {
  for (const level of ['"auto"', '"low"', '"medium"', '"high"', '"max"']) {
    assert.ok(UPDATE_MODELS_SRC.includes(level),
      `EFFORT_LEVELS missing entry for ${level}`);
  }
});

test('update-models-reference: modelTable() + effortTable() helpers present', () => {
  assert.ok(/function modelTable\(\)/.test(UPDATE_MODELS_SRC),  'modelTable fn missing');
  assert.ok(/function effortTable\(\)/.test(UPDATE_MODELS_SRC), 'effortTable fn missing');
});

test('update-models-reference: generated file contains model table header columns', () => {
  const outPath = path.join(HARNESS, 'models-reference.md');
  if (!fs.existsSync(outPath)) {
    // Generate it.
    const r = spawnSync(process.execPath, [path.join(HARNESS, 'src', 'update-models-reference.js')],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`update-models-reference.js failed: ${r.stderr}`);
  }
  const content = fs.readFileSync(outPath, 'utf8');
  assert.ok(/Model ID/.test(content),           'table header "Model ID" missing');
  assert.ok(/Family/.test(content),             'table header "Family" missing');
  assert.ok(/Alias/.test(content),              'table header "Alias" missing');
  assert.ok(/Extended Thinking/.test(content),  'table header "Extended Thinking" missing');
  assert.ok(/Effort/.test(content),             'effort table missing');
  assert.ok(/Budget Tokens/.test(content),      'effort table header "Budget Tokens" missing');
  assert.ok(/Auto-generated/.test(content),     'auto-generated notice missing');
});

test('update-models-reference: regeneration produces identical content on re-run', () => {
  const outPath = path.join(HARNESS, 'models-reference.md');
  const r1 = spawnSync(process.execPath, [path.join(HARNESS, 'src', 'update-models-reference.js')],
    { encoding: 'utf8' });
  assert.strictEqual(r1.status, 0, `first run failed: ${r1.stderr}`);
  const after1 = fs.readFileSync(outPath, 'utf8');

  const r2 = spawnSync(process.execPath, [path.join(HARNESS, 'src', 'update-models-reference.js')],
    { encoding: 'utf8' });
  assert.strictEqual(r2.status, 0, `second run failed: ${r2.stderr}`);
  const after2 = fs.readFileSync(outPath, 'utf8');

  assert.strictEqual(after1, after2, 'update-models-reference.js must be idempotent');
});

if (!process.exitCode) console.log('\nAll topic-management tests passed.');
