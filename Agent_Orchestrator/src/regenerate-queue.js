#!/usr/bin/env node
/**
 * Regenerate a topic's prompt-queue.md file (destructive).
 *
 * Wipes all current blocks (including any seed-merged content) and writes
 * a fresh seeded queue file via `promptQueue.ensureQueueFile`.
 *
 * Usage:
 *   node regenerate-queue.js                # last-touched / current topic
 *   node regenerate-queue.js <topic|id>     # named topic or topic-id
 *   node regenerate-queue.js all            # every registered topic
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');
const promptQueue = require('./prompt-queue');

const ROOT = path.join(__dirname, '..', '..');

// ---------- Logging helpers ----------
function log(m) { console.log(`[harness-regenerate-queue] ${m}`); }
function die(m) { console.error(`[harness-regenerate-queue] ERROR: ${m}`); process.exit(1); }

// ---------- Load global config + known topic set ----------
const configPath = configUtils.globalConfigPath();
if (!fs.existsSync(configPath)) die(`global-config.json not found at ${configPath}`);
const config = configUtils.loadConfig(configPath);
const topicIds = config['topic-ids'] || config.topicIds || {};
const knownTopics = new Set(Object.values(topicIds));

// ---------- Per-topic regeneration (resolve dir -> wipe -> reseed) ----------
function regenOne(topicName) {
  const td = configUtils.topicDirFor(ROOT, config, topicName);
  if (!fs.existsSync(td)) { log(`topic dir not found, skipped: ${td}`); return; }
  const r = promptQueue.regenerateQueueFile(td);
  const rel = path.relative(ROOT, r.file).replace(/\\/g, '/');
  if (r.error) log(`${topicName}: regen FAILED (${r.error})`);
  else log(`${topicName}: wiped ${r.priorCount} prior user block(s) (seed excluded) -> ${rel}`);
}

// ---------- CLI dispatch: single topic | id alias | "all" sweep ----------
const arg = process.argv.slice(2).filter(Boolean)[0];
if (!arg || arg === 'all') {
  const names = [...knownTopics];
  if (!names.length) { log('no topics registered.'); process.exit(0); }
  for (const n of names) regenOne(n);
} else {
  const topic = topicIds[arg] ? topicIds[arg] : arg;
  if (topic !== arg) log(`ID "${arg}" -> topic "${topic}"`);
  if (!knownTopics.has(topic)) die(`unknown topic "${topic}". Available: ${[...knownTopics].join(', ')}`);
  regenOne(topic);
}
