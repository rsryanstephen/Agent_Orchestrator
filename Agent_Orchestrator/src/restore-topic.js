#!/usr/bin/env node
/**
 * Topic restore utility.
 * Usage: node Agent_Orchestrator/src/restore-topic.js <archived-name> [new-name]
 *
 * archived-name  – folder name inside <topic-files-dir>/Archived/
 * new-name       – name to restore the topic as (defaults to archived-name)
 *
 * Moves <topic-files-dir>/Archived/<archived-name>/ back to <topic-files-dir>/<new-name>/
 * and registers the topic in global-config.json with an auto-assigned or collision-safe ID.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');

const ROOT = path.join(__dirname, '..', '..');

function log(msg) { console.log(`[harness-restore-topic.js] ${msg}`); }
function die(msg) { console.error(`[harness-restore-topic.js] ERROR: ${msg}`); process.exit(1); }

// Argv: archived folder name + optional target name.
const [, , archivedName, newNameArg] = process.argv;
if (!archivedName) die('Usage: node Agent_Orchestrator/src/restore-topic.js <archived-name> [new-name]');
const newName = (newNameArg && newNameArg.trim()) ? newNameArg.trim() : archivedName;

// Load global config.
const configPath = configUtils.globalConfigPath();
if (!fs.existsSync(configPath)) die(`global-config.json not found at ${configPath}`);
const config = configUtils.loadConfig(configPath);
if (config.__hasComments) log('Note: JSONC comments will be stripped on write.');
const topicFilesDir = configUtils.resolveTopicFilesDir(config);
const topicIds = config['topic-ids'] = config['topic-ids'] || {};

// Guard: target name must not already be registered.
const knownTopics = new Set(Object.values(topicIds));
if (knownTopics.has(newName)) die(`Topic "${newName}" is already registered. Choose a different name.`);

// Guard: target directory must not already exist on disk.
const destDir = path.join(ROOT, topicFilesDir, newName);
if (fs.existsSync(destDir)) die(`Destination directory already exists: ${topicFilesDir}/${newName}/`);

// Locate the archived folder.
const archivedBase = path.join(ROOT, topicFilesDir, 'Archived');
const srcDir = path.join(archivedBase, archivedName);
if (!fs.existsSync(srcDir)) {
  // List available archived folders to help the user.
  let available = '';
  if (fs.existsSync(archivedBase)) {
    const entries = fs.readdirSync(archivedBase).filter(e =>
      fs.statSync(path.join(archivedBase, e)).isDirectory()
    );
    available = entries.length > 0 ? ` Available: ${entries.join(', ')}` : ' No archived topics found.';
  } else {
    available = ' Archived directory does not exist.';
  }
  die(`Archived topic not found: ${topicFilesDir}/Archived/${archivedName}/${available}`);
}

// Move the folder back to the active topic-files directory.
try {
  fs.renameSync(srcDir, destDir);
  log(`Restored: ${topicFilesDir}/Archived/${archivedName}/ -> ${topicFilesDir}/${newName}/`);
} catch (err) {
  die(`Failed to restore folder: ${err.message}`);
}

// If the topic was renamed, rename the history .md file inside to match newName.
// The canonical history file is <topicName>.md; after a rename it may still carry the old name.
if (newName !== archivedName) {
  const oldMd = path.join(destDir, `${archivedName}.md`);
  const newMd = path.join(destDir, `${newName}.md`);
  if (fs.existsSync(oldMd) && !fs.existsSync(newMd)) {
    fs.renameSync(oldMd, newMd);
    log(`Renamed history file: ${archivedName}.md -> ${newName}.md`);
  }
  // Update prompt-file in topic-config.json if present.
  const topicConfigPath = path.join(destDir, configUtils.TOPIC_CONFIG_FILENAME);
  if (fs.existsSync(topicConfigPath)) {
    const topicConfig = configUtils.loadConfig(topicConfigPath);
    if (topicConfig['prompt-file'] === `${archivedName}.md`) {
      topicConfig['prompt-file'] = `${newName}.md`;
      configUtils.writeConfig(topicConfigPath, topicConfig);
      log(`Updated prompt-file in topic-config.json: ${newName}.md`);
    }
  }
}

// Auto-assign the next available numeric ID.
const usedIds = Object.keys(topicIds).map(Number).filter(n => !isNaN(n));
const numericId = String(usedIds.length > 0 ? Math.max(...usedIds) + 1 : 1);
topicIds[numericId] = newName;

configUtils.writeConfig(configPath, config);
log(`Registered "${newName}" as ID ${numericId} in global-config.json.`);
log(`Done. Set topic with: hset ${numericId}`);
