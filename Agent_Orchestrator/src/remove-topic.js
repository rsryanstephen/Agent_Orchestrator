#!/usr/bin/env node
/**
 * Topic archival utility.
 * Usage: node Agent_Orchestrator/remove-topic.js <topic|id|all>
 *
 * all       – moves ALL topic folders into <topic-files-dir>/Archived/ and resets topics/ids in global-config.json
 * topic|id  – moves <topic-files-dir>/<topic>/ into <topic-files-dir>/Archived/ and removes the topic from global-config.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');

const ROOT = path.join(__dirname, '..', '..');

function log(msg) { console.log(`[harness-remove-topic.js] ${msg}`); }
function die(msg) { console.error(`[harness-remove-topic.js] ERROR: ${msg}`); process.exit(1); }

// Argv: single positional topic name / id / literal "all".
const [, , topicArg] = process.argv;
if (!topicArg) die('Usage: node Agent_Orchestrator/remove-topic.js <topic|id|all>');

// Load global config; abort if missing.
const configPath = configUtils.globalConfigPath();
if (!fs.existsSync(configPath)) die(`global-config.json not found at ${configPath}`);
const config = configUtils.loadConfig(configPath);
if (config.__hasComments) log('Note: JSONC comments will be stripped on write.');
const topicFilesDir = configUtils.resolveTopicFilesDir(config);

// Moves the topic's folder into <topic-files-dir>/Archived/ instead of deleting it.
// If a same-named folder already exists in Archived, appends a timestamp suffix to avoid collisions.
function deleteTopicDir(topicName) {
  const dir = path.join(ROOT, topicFilesDir, topicName);
  if (!fs.existsSync(dir)) {
    log(`Directory not found, skipped: ${topicFilesDir}/${topicName}/`);
    return;
  }
  const archivedBase = path.join(ROOT, topicFilesDir, 'Archived');
  fs.mkdirSync(archivedBase, { recursive: true });
  let dest = path.join(archivedBase, topicName);
  if (fs.existsSync(dest)) {
    dest = path.join(archivedBase, `${topicName}-${Date.now()}`);
  }
  try {
    fs.renameSync(dir, dest);
    log(`Archived: ${topicFilesDir}/${topicName}/ -> ${topicFilesDir}/Archived/${path.basename(dest)}/`);
  } catch (err) {
    log(`Failed to archive ${topicFilesDir}/${topicName}/: ${err.message}`);
  }
}

// Build id->name map + lookup set.
const topicIds = config['topic-ids'] = config['topic-ids'] || {};
const knownTopics = new Set(Object.values(topicIds));

// Drop every id binding that pointed at the deleted topic.
function removeTopicFromConfig(topicName) {
  for (const [id, name] of Object.entries(topicIds)) {
    if (name === topicName) {
      delete topicIds[id];
      log(`Removed ID ${id} → "${topicName}" from topic-ids`);
    }
  }
}

// Dispatch: "all" -> nuke every topic + reset id map; otherwise delete one.
if (topicArg === 'all') {
  const names = [...knownTopics];
  if (names.length === 0) { log('No topics registered.'); }
  for (const name of names) deleteTopicDir(name);
  config['topic-ids'] = {};
  log('Reset topic-ids to {}');
} else {
  const topic = topicIds[topicArg] ? topicIds[topicArg] : topicArg;
  if (topic !== topicArg) log(`ID "${topicArg}" → topic "${topic}"`);
  if (!knownTopics.has(topic)) die(`Unknown topic "${topic}". Available: ${[...knownTopics].join(', ')}`);
  deleteTopicDir(topic);
  removeTopicFromConfig(topic);
}

configUtils.writeConfig(configPath, config);
log('global-config.json updated.');
