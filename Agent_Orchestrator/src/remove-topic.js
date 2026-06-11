#!/usr/bin/env node
/**
 * Hard topic removal utility.
 * Usage: node Agent_Orchestrator/remove-topic.js <topic|id|all>
 *
 * all       – deletes ALL topic folders under <topic-files-dir>/ and resets topics/ids in global-config.json
 * topic|id  – deletes <topic-files-dir>/<topic>/ and removes the topic from global-config.json
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

// Filesystem delete helper — recursive rmdir of the topic's folder.
function deleteTopicDir(topicName) {
  const dir = path.join(ROOT, topicFilesDir, topicName);
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`Deleted: ${topicFilesDir}/${topicName}/`);
    } catch (err) {
      log(`Failed to delete ${topicFilesDir}/${topicName}/: ${err.message}`);
    }
  } else {
    log(`Directory not found, skipped: ${topicFilesDir}/${topicName}/`);
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
