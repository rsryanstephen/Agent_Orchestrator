#!/usr/bin/env node
/**
 * Memory compression utility — single-file-per-topic architecture.
 *
 * Usage:
 *   node compress-memory.js              – all topics
 *   node compress-memory.js <topic|id>   – that topic
 *   node compress-memory.js all          – all topics
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');
const { getProvider } = require('./lib/providers/registry');

const ROOT = path.join(__dirname, '..', '..');
const CLEAR_MARKER = '<!-- CLEAR CONTEXT -->';
const CLEAR_MARKER_OLD = '--- CLEAR CONTEXT ---';

function log(msg) { console.log(`[harness-compress-memory.js] ${msg}`); }
function die(msg) { console.error(`[harness-compress-memory.js] ERROR: ${msg}`); process.exit(1); }

const args = process.argv.slice(2).filter(a => a !== '');
const topicArg = args.length === 0 ? 'all' : args[0];

const configPath = configUtils.globalConfigPath();
if (!fs.existsSync(configPath)) die(`global-config.json not found at ${configPath}`);
const config = configUtils.loadConfig(configPath);

// ---------- Active-content extraction: trim history to text after last CLEAR marker ----------
function getActiveContent(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const newIdx = content.lastIndexOf(CLEAR_MARKER);
  const oldIdx = content.lastIndexOf(CLEAR_MARKER_OLD);
  let lastClearIdx, markerLen;
  if (newIdx >= oldIdx && newIdx >= 0) { lastClearIdx = newIdx; markerLen = CLEAR_MARKER.length; }
  else if (oldIdx >= 0) { lastClearIdx = oldIdx; markerLen = CLEAR_MARKER_OLD.length; }
  else { lastClearIdx = -1; markerLen = 0; }
  const raw = lastClearIdx >= 0 ? content.slice(lastClearIdx + markerLen) : content;
  return raw.trim();
}

// ---------- Provider invocation + summarization prompt builder ----------
async function callClaude(prompt) {
  const provider = getProvider();
  const result = await provider.spawn(prompt, { silent: true, label: 'compress-memory' });
  return (result.text || '').trim();
}

async function summarizeContent(content) {
  const prompt = `Summarize the following conversation history into a compact context block. Preserve: key decisions, requirements, important implementation details, identified bugs/fixes, and any unresolved issues. Omit: verbose explanations, redundant repetition, and anything superseded by later entries. Output only the summary — no preamble.\n\n${content}`;
  return callClaude(prompt);
}

// ---------- Manual compress: backup -> summarize -> append CLEAR + summary block ----------
async function compressTopic(topicName) {
  const filePath = configUtils.historyPathFor(ROOT, config, topicName);
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (!fs.existsSync(filePath)) { log(`File not found, skipped: ${rel}`); return; }

  const active = getActiveContent(filePath);
  if (!active) { log(`No active content to compress in: ${rel}`); return; }

  const backupsDir = path.join(path.dirname(filePath), 'backups');
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${path.basename(filePath, '.md')}-${isoStamp}.md`;
  const backupPath = path.join(backupsDir, backupName);
  fs.copyFileSync(filePath, backupPath);
  const backupRel = path.relative(ROOT, backupPath).replace(/\\/g, '/');
  log(`Backup created: ${backupRel}`);

  log(`Compressing: ${rel} ...`);
  const prompt = `Summarize the following conversation history into a compact context block. Preserve: key decisions, requirements, important implementation details, identified bugs/fixes, and any unresolved issues. Omit: verbose explanations, redundant repetition, and anything superseded by later entries. Output only the summary — no preamble.\n\n${active}`;

  let summary;
  try { summary = await callClaude(prompt); }
  catch (err) { log(`Failed to compress ${rel}: ${err.message}`); return; }

  // Trailing `## User Prompt` is only appended if the file does not already
  // end with one (tagged or untagged). Otherwise we would stack a duplicate
  // placeholder on top of an existing trailing header and re-trigger the
  // latest-prompt parsing ambiguity normalize-history exists to fix.
  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch {}
  const trailingPlaceholderPresent = /##\s+User Prompt(?:\s+\([^)]+\))?\s*\n*\s*$/.test(existing);
  const trailer = trailingPlaceholderPresent ? '' : '\n\n## User Prompt\n';
  const compressed = `\n\n${CLEAR_MARKER}\n\n## Coding Agent Response (Compressed Memory)\n\n${summary}${trailer}`;
  try {
    fs.appendFileSync(filePath, compressed, 'utf8');
    log(`Compressed: ${rel}`);
  } catch (err) {
    log(`Failed to write ${rel}: ${err.message}`);
  }
}

// ---------- Auto-compress trigger: line-count guard + System Notice annotation ----------
async function autoCompressIfNeeded(topicName, threshold = 300) {
  const filePath = configUtils.historyPathFor(ROOT, config, topicName);
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const lineCount = content.split('\n').length;
  if (lineCount < threshold) return;

  const backupsDir = path.join(path.dirname(filePath), 'backups');
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${path.basename(filePath, '.md')}-${isoStamp}.md`;
  const backupPath = path.join(backupsDir, backupName);
  fs.copyFileSync(filePath, backupPath);
  const backupRel = path.relative(ROOT, backupPath).replace(/\\/g, '/');

  console.log(`[harness-auto-compress] Topic "${topicName}" has ${lineCount} lines (threshold: ${threshold}). Compressing...`);
  console.log(`[harness-auto-compress] Backup created: ${backupRel}`);

  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const active = getActiveContent(filePath);
  if (!active) { console.log(`[harness-auto-compress] No active content in: ${rel}`); return; }

  const prompt = `Summarize the following conversation history into a compact context block. Preserve: key decisions, requirements, important implementation details, identified bugs/fixes, and any unresolved issues. Omit: verbose explanations, redundant repetition, and anything superseded by later entries. Output only the summary — no preamble.\n\n${active.slice(0, 12000)}`;

  let summary;
  try { summary = await callClaude(prompt); }
  catch (err) { console.log(`[harness-auto-compress] Failed to compress ${rel}: ${err.message}`); return; }

  const provider = getProvider();
  const providerName = (provider && provider.name) ? provider.name : 'unknown';
  const timestamp = new Date().toISOString();

  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch {}
  const trailingPlaceholderPresent = /##\s+User Prompt(?:\s+\([^)]+\))?\s*\n*\s*$/.test(existing);
  const trailer = trailingPlaceholderPresent ? '' : '\n\n## User Prompt\n';

  const noticeBlock = `\n\n## System Notice (Auto-Compression)\n\n- Original line count: ${lineCount}\n- Threshold: ${threshold}\n- Backup: \`${backupRel}\`\n- Timestamp: ${timestamp}\n- Provider: ${providerName}`;
  const compressed = `\n\n${CLEAR_MARKER}\n\n## Coding Agent Response (Compressed Memory)\n\n${summary}${noticeBlock}${trailer}`;

  try {
    fs.appendFileSync(filePath, compressed, 'utf8');
    console.log(`[harness-auto-compress] Compressed: ${rel}`);
  } catch (err) {
    console.log(`[harness-auto-compress] Failed to write ${rel}: ${err.message}`);
  }
}

module.exports = { compressTopic, autoCompressIfNeeded, summarizeContent };

// ---------- CLI dispatch: single topic | id alias | "all" sweep ----------
if (require.main === module) {
  const topicIds = config['topic-ids'] || config.topicIds || {};
  const knownTopics = new Set(Object.values(topicIds));

  (async () => {
    if (topicArg === 'all') {
      const names = [...knownTopics];
      if (names.length === 0) { log('No topics registered.'); process.exit(0); }
      for (const name of names) { log(`--- Topic: ${name} ---`); await compressTopic(name); }
    } else {
      const topic = topicIds[topicArg] ? topicIds[topicArg] : topicArg;
      if (topic !== topicArg) log(`ID "${topicArg}" → topic "${topic}"`);
      if (!knownTopics.has(topic)) die(`Unknown topic "${topic}". Available: ${[...knownTopics].join(', ')}`);
      await compressTopic(topic);
    }
  })().catch(err => { die(err.message); });
}
