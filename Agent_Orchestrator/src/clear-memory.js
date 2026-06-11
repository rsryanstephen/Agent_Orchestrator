#!/usr/bin/env node
/**
 * Memory clearing utility — single-file-per-topic architecture.
 *
 * Usage:
 *   node clear-memory.js                  – all topics
 *   node clear-memory.js <topic|id>       – that topic
 *   node clear-memory.js all              – all topics
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');
const { normalizeTrailingPromptStack } = require('./normalize-history');

// Constants: project root + HTML marker appended to history to signal context wipe.
const ROOT = path.join(__dirname, '..', '..');
const CLEAR_MARKER = '\n\n<!-- CLEAR CONTEXT -->\n\n';

// Console helpers — tagged log + fatal die.
function log(msg) { console.log(`[harness-clear-memory.js] ${msg}`); }
function die(msg) { console.error(`[harness-clear-memory.js] ERROR: ${msg}`); process.exit(1); }

// Argv parsing: optional `--normalize` flag (collapse duplicate trailing prompts only),
// positional topic name/id (defaults to "all").
const rawArgs = process.argv.slice(2).filter(a => a !== '');
const normalizeOnly = rawArgs.includes('--normalize');
const args = rawArgs.filter(a => a !== '--normalize');
const topicArg = args.length === 0 ? 'all' : args[0];

// Load global config (fail fast if missing).
const configPath = configUtils.globalConfigPath();
if (!fs.existsSync(configPath)) die(`global-config.json not found at ${configPath}`);
const config = configUtils.loadConfig(configPath);

// Per-topic action: either normalize (dedupe trailing prompt placeholders) or
// append the CLEAR_MARKER which downstream code uses to truncate context.
function clearTopic(topicName) {
  const filePath = configUtils.historyPathFor(ROOT, config, topicName);
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (!fs.existsSync(filePath)) { log(`File not found, skipped: ${rel}`); return; }
  if (normalizeOnly) {
    try {
      const collapsed = normalizeTrailingPromptStack(filePath);
      log(`Normalized: ${rel} — collapsed ${collapsed} duplicate trailing \`## User Prompt\` placeholder(s).`);
    } catch (err) {
      log(`Failed to normalize ${rel}: ${err.message}`);
    }
    return;
  }
  try {
    fs.appendFileSync(filePath, CLEAR_MARKER, 'utf8');
    log(`Context cleared: ${rel}`);
  } catch (err) {
    log(`Failed to clear ${rel}: ${err.message}`);
  }
}

// Dispatch: resolve topic arg against the id->name map, then clear one or all.
const topicIds = config['topic-ids'] || config.topicIds || {};
const knownTopics = new Set(Object.values(topicIds));
if (topicArg === 'all') {
  const names = [...knownTopics];
  if (names.length === 0) { log('No topics registered.'); process.exit(0); }
  for (const name of names) { log(`--- Topic: ${name} ---`); clearTopic(name); }
} else {
  const topic = topicIds[topicArg] ? topicIds[topicArg] : topicArg;
  if (topic !== topicArg) log(`ID "${topicArg}" → topic "${topic}"`);
  if (!knownTopics.has(topic)) die(`Unknown topic "${topic}". Available: ${[...knownTopics].join(', ')}`);
  clearTopic(topic);
}
