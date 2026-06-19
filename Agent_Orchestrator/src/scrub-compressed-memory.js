#!/usr/bin/env node
/**
 * One-shot scrub utility.
 *
 * Removes legacy `## Coding Agent Response (Compressed Memory)` and standalone
 * `## Compressed Memory` sections from topic history files. The harness no
 * longer injects these blocks; this script is provided so existing topic files
 * can be cleaned without manual editing.
 *
 * Usage:
 *   node scrub-compressed-memory.js                – all topics
 *   node scrub-compressed-memory.js <topic|id>    – that topic
 *   node scrub-compressed-memory.js all           – all topics
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');

const ROOT = path.join(__dirname, '..', '..');

function log(msg) { console.log(`[harness-scrub-compressed-memory.js] ${msg}`); }
function die(msg) { console.error(`[harness-scrub-compressed-memory.js] ERROR: ${msg}`); process.exit(1); }

// Strip every `## Coding Agent Response (Compressed Memory)` and `## Compressed Memory`
// block from `content`. A section runs from its header line up to the next `## `
// header (any kind) or EOF. Returns { out, removed } so callers can report.
function stripCompressedSections(content) {
  // Match both legacy header variants; case-insensitive on the suffix so old
  // typos / spacing variants are also caught.
  const headerRe = /^##\s+(?:Coding Agent Response\s*\(Compressed Memory\)|Compressed Memory)\s*$/gim;
  let removed = 0;
  let out = content;
  while (true) {
    headerRe.lastIndex = 0;
    const m = headerRe.exec(out);
    if (!m) break;
    const start = m.index;
    // Tail begins after the matched header line.
    const tailStart = start + m[0].length;
    const tail = out.slice(tailStart);
    const nextHeaderRel = tail.search(/^##\s+/m);
    const end = nextHeaderRel >= 0 ? tailStart + nextHeaderRel : out.length;
    // Also consume the divider/whitespace that typically precedes the header
    // (`\n\n---\n\n`) so we don't leave dangling separators behind.
    let realStart = start;
    const prefixMatch = out.slice(0, start).match(/(\n+(?:---\s*\n+)?)$/);
    if (prefixMatch) realStart = start - prefixMatch[0].length;
    // Preserve a single `\n\n` boundary so any following `## ` header stays at
    // line-start for the next iteration of the loop (and for downstream parsers).
    const left = out.slice(0, realStart);
    const right = out.slice(end);
    const sep = (left.length > 0 && right.length > 0 && !left.endsWith('\n')) ? '\n\n' : '';
    out = left + sep + right;
    removed += 1;
  }
  // Collapse any runs of 3+ blank lines that the cuts may have created.
  out = out.replace(/\n{4,}/g, '\n\n\n');
  return { out, removed };
}

// Atomic-ish write: save a `.bak` copy first, then overwrite the original.
function scrubFile(filePath) {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (!fs.existsSync(filePath)) { log(`File not found, skipped: ${rel}`); return; }
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch (err) { log(`Failed to read ${rel}: ${err.message}`); return; }
  const { out, removed } = stripCompressedSections(content);
  if (removed === 0) { log(`Clean (no Compressed Memory sections): ${rel}`); return; }
  try { fs.writeFileSync(filePath + '.bak', content, 'utf8'); }
  catch (err) { log(`Failed to write backup for ${rel}: ${err.message}`); return; }
  try {
    fs.writeFileSync(filePath, out, 'utf8');
    log(`Scrubbed ${removed} section(s) from ${rel} (backup: ${rel}.bak)`);
  } catch (err) {
    log(`Failed to write ${rel}: ${err.message}`);
  }
}

// Walk `.md` files under the topic dir but treat archived snapshots as
// immutable: skip `backups/` and `Archive/` subtrees so only live history is
// rewritten. Frozen archives must not be mutated by a one-shot scrub.
function scrubTopic(topicName, config) {
  const filePath = configUtils.historyPathFor(ROOT, config, topicName);
  const topicDir = path.dirname(filePath);
  if (!fs.existsSync(topicDir)) { log(`Topic dir not found: ${topicDir}`); return; }
  const SKIP_DIRS = new Set(['backups', 'archive']);
  const stack = [topicDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name.toLowerCase())) {
          log(`Skipping archive dir: ${path.relative(ROOT, p).replace(/\\/g, '/')}`);
          continue;
        }
        stack.push(p);
        continue;
      }
      if (ent.isFile() && p.toLowerCase().endsWith('.md')) scrubFile(p);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2).filter(a => a !== '');
  const topicArg = args.length === 0 ? 'all' : args[0];

  const configPath = configUtils.globalConfigPath();
  if (!fs.existsSync(configPath)) die(`global-config.json not found at ${configPath}`);
  const config = configUtils.loadConfig(configPath);

  const topicIds = config['topic-ids'] || config.topicIds || {};
  const knownTopics = new Set(Object.values(topicIds));

  if (topicArg === 'all') {
    const names = [...knownTopics];
    if (names.length === 0) { log('No topics registered.'); process.exit(0); }
    for (const name of names) { log(`--- Topic: ${name} ---`); scrubTopic(name, config); }
  } else {
    const topic = topicIds[topicArg] ? topicIds[topicArg] : topicArg;
    if (topic !== topicArg) log(`ID "${topicArg}" → topic "${topic}"`);
    if (!knownTopics.has(topic)) die(`Unknown topic "${topic}". Available: ${[...knownTopics].join(', ')}`);
    scrubTopic(topic, config);
  }
}

module.exports = { stripCompressedSections };
