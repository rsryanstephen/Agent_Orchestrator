#!/usr/bin/env node
/**
 * Assigns a numerical ID to an existing topic in global-config.json.
 * Also mirrors the id into the topic's topic-config.json.
 * Usage: node Agent_Orchestrator/set-topic.js <topic-name> <numerical-id>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = configUtils.globalConfigPath();

function log(msg) { console.log(`[harness-set-topic.js] ${msg}`); }
function die(msg) { console.error(`[harness-set-topic.js] ERROR: ${msg}`); process.exit(1); }

// Argv validation: topic name + numeric id required; id must be digits only.
const [, , topicName, numericId] = process.argv;
if (!topicName || !numericId) die('Usage: node Agent_Orchestrator/set-topic.js <topic-name> <numerical-id>');
if (!/^\d+$/.test(numericId)) die(`numerical-id must be a number, got: "${numericId}"`);

// Load config + verify the topic exists (either in id map or on disk).
const config = configUtils.loadConfig(CONFIG);
const topicIds = config['topic-ids'] = config['topic-ids'] || {};
const knownTopics = new Set(Object.values(topicIds));
if (!knownTopics.has(topicName)) {
  const topicDir = configUtils.topicDirFor(ROOT, config, topicName);
  if (!fs.existsSync(topicDir)) die(`Topic "${topicName}" not found. Available: ${[...knownTopics].join(', ')}`);
}

// Drop any stale id rows pointing at this topic, then warn if we're stealing an id.
for (const [id, name] of Object.entries(topicIds)) {
  if (name === topicName && id !== numericId) {
    delete topicIds[id];
    log(`Removed stale ID ${id} → "${topicName}"`);
  }
}

const existing = topicIds[numericId];
if (existing && existing !== topicName) {
  log(`ID ${numericId} was assigned to "${existing}", reassigning to "${topicName}"`);
}

// Commit new binding to global config.
topicIds[numericId] = topicName;
configUtils.writeConfig(CONFIG, config);

// Mirror the id into the topic's own topic-config.json (canonical key: topic-id).
const tc = configUtils.loadTopicConfig(ROOT, config, topicName);
if (tc) {
  tc['topic-id'] = numericId;
  delete tc.id;
  configUtils.writeTopicConfig(ROOT, config, topicName, tc);
  log(`Updated topic-id in ${configUtils.TOPIC_CONFIG_FILENAME} for "${topicName}"`);
}

log(`ID ${numericId} → "${topicName}"`);
