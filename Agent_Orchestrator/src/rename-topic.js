#!/usr/bin/env node
/**
 * Renames a topic: moves its folder + history file, updates global-config.json
 * (topics + ids), and rewrites the topic's topic-config.json id if changed.
 * Usage: node Agent_Orchestrator/rename-topic.js <topic-name|id> <new-topic-name>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = configUtils.globalConfigPath();

function log(msg) { console.log(`[harness-rename-topic.js] ${msg}`); }
function die(msg) { console.error(`[harness-rename-topic.js] ERROR: ${msg}`); process.exit(1); }

// Argv: <topic-name|id> <new-topic-name>. Both required.
const [, , topicArg, newName] = process.argv;
if (!topicArg || !newName) die('Usage: node Agent_Orchestrator/rename-topic.js <topic-name|id> <new-topic-name>');

// Load global config + resolve old/new topic names against the id map.
const config = configUtils.loadConfig(CONFIG);
if (config.__hasComments) log('Note: JSONC comments will be stripped on write.');
const topicFilesDir = configUtils.resolveTopicFilesDir(config);
const LOGS = path.join(ROOT, topicFilesDir);

const topicIds = config['topic-ids'] = config['topic-ids'] || {};
const knownTopics = new Set(Object.values(topicIds));
const oldName = topicIds[topicArg] ? topicIds[topicArg] : topicArg;
if (!knownTopics.has(oldName)) die(`Topic "${oldName}" not found. Available: ${[...knownTopics].join(', ')}`);
if (oldName === newName) die('New name is the same as the current name.');

// Filesystem move: rename topic dir + history md file. Staging dir moves with it;
// orphans warn (indicates crashed parallel batch).
const oldDir = path.join(LOGS, oldName);
const newDir = path.join(LOGS, newName);

try {
  if (!fs.existsSync(oldDir)) die(`Directory not found: ${oldDir}`);
  if (fs.existsSync(newDir)) die(`Target directory already exists: ${newDir}`);
  fs.renameSync(oldDir, newDir);
  log(`Renamed directory: ${topicFilesDir}/${oldName}/ → ${topicFilesDir}/${newName}/`);
  // .staging/ moves atomically with the directory. Warn if orphaned staging
  // files exist (indicates a crash during a parallel batch; run hresume to recover).
  const stagingDir = path.join(newDir, '.staging');
  if (fs.existsSync(stagingDir)) {
    const stagingFiles = fs.readdirSync(stagingDir).filter(n => n.endsWith('.md'));
    if (stagingFiles.length > 0) {
      log(`Warning: ${stagingFiles.length} orphaned staging file(s) moved with topic — run hresume to recover interrupted parallel batch.`);
    }
  }

  const candidates = [`${oldName}.md`];
  for (const from of candidates) {
    const to = from.replace(oldName, newName);
    const fromPath = path.join(newDir, from);
    const toPath = path.join(newDir, to);
    if (fs.existsSync(fromPath)) {
      fs.renameSync(fromPath, toPath);
      log(`Renamed: ${from} → ${to}`);
    }
  }
} catch (err) {
  die(`Filesystem error: ${err.message}`);
}

// Rewrite every id mapping that pointed at oldName -> newName, then persist global config.
for (const [id, name] of Object.entries(topicIds)) {
  if (name === oldName) {
    topicIds[id] = newName;
    log(`Updated ID ${id}: "${oldName}" → "${newName}"`);
  }
}

configUtils.writeConfig(CONFIG, config);
log(`global-config.json updated.`);

// Update prompt-file in topic-config.json to reflect the renamed history file.
const tcPath = path.join(newDir, configUtils.TOPIC_CONFIG_FILENAME);
if (fs.existsSync(tcPath)) {
  try {
    const tc = configUtils.loadConfig(tcPath);
    if (tc['prompt-file'] === `${oldName}.md`) {
      tc['prompt-file'] = `${newName}.md`;
      configUtils.writeConfig(tcPath, tc);
      log(`Updated prompt-file in ${configUtils.TOPIC_CONFIG_FILENAME}: "${oldName}.md" → "${newName}.md"`);
    }
  } catch (e) {
    log(`Warning: could not update prompt-file in ${configUtils.TOPIC_CONFIG_FILENAME}: ${e.message}`);
  }
}

log(`Done. Topic "${oldName}" is now "${newName}".`);
