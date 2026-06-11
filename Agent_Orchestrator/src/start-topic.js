#!/usr/bin/env node
/**
 * Agent topic initializer.
 * Usage: node Agent_Orchestrator/start-topic.js <topic-name> [numerical-id]
 *
 * Creates <topic-files-dir>/<topic>/ with <topic>.md (history) and topic-config.json
 * (per-topic overrides seeded in global key order), then registers the topic +
 * its ID in Agent_Orchestrator/global-config.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configUtils = require('./config-utils');

const ROOT = path.join(__dirname, '..', '..');
const HARNESS = path.join(__dirname, '..');
const LOCK_PATH = path.join(HARNESS, '.global-config.lock');

function log(msg) { console.log(`[harness-start-topic.js] ${msg}`); }
function die(msg) { console.error(`[harness-start-topic.js] ERROR: ${msg}`); process.exit(1); }

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---------- Global-config file lock (PID-stamped) to serialize concurrent topic creation ----------
function acquireConfigLock() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' }); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const ownerPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10);
        try { process.kill(ownerPid, 0); } catch { fs.unlinkSync(LOCK_PATH); continue; }
      } catch {}
      sleepMs(100);
    }
  }
  die('Timed out waiting for global-config.json lock after 30s');
}
function releaseConfigLock() { try { fs.unlinkSync(LOCK_PATH); } catch {} }

// ---------- CLI arg parse + global-config load ----------
const [, , topicName, idArg] = process.argv;
if (!topicName) {
  die('Usage: node Agent_Orchestrator/start-topic.js <topic-name> [numerical-id]\n\n  Example: node Agent_Orchestrator/start-topic.js user-auth 2');
}

const configPath = configUtils.globalConfigPath();
if (!fs.existsSync(configPath)) die(`global-config.json not found at ${configPath}`);
acquireConfigLock();
process.on('exit', releaseConfigLock);
const config = configUtils.loadConfig(configPath);
if (config.__hasComments) log('Note: global-config.json contains JSONC comments — they will be stripped when this script writes back the updated config.');
const topicIds = config['topic-ids'] = config['topic-ids'] || {};

// ---------- Numeric topic-id resolution: explicit arg, validated, or auto-assigned (max+1) ----------
let numericId;
if (idArg && /^\d+$/.test(idArg)) {
  numericId = idArg;
} else {
  if (idArg && idArg !== '{}') log(`Invalid id "${idArg}" — auto-assigning next available ID`);
  const usedIds = Object.keys(topicIds).map(Number).filter(n => !isNaN(n));
  numericId = String(usedIds.length > 0 ? Math.max(...usedIds) + 1 : 1);
  log(`Auto-assigned ID: ${numericId}`);
}

// ---------- Scaffold topic dir + history file + (optional) prompt-queue seed ----------
const topicFilesDir = configUtils.resolveTopicFilesDir(config);
const topicDir = path.join(ROOT, topicFilesDir, topicName);
if (!fs.existsSync(topicDir)) {
  fs.mkdirSync(topicDir, { recursive: true });
  log(`Created directory: ${topicFilesDir}/${topicName}/`);
}

const historyFile = path.join(topicDir, `${topicName}.md`);
fs.writeFileSync(historyFile, `# ${topicName} - chat history\n\n## User Prompt\n`, 'utf8');
log(`Created: ${topicFilesDir}/${topicName}/${topicName}.md`);

try {
  const promptQueue = require('./prompt-queue');
  if (promptQueue.ensureQueueFile(topicDir)) {
    log(`Created: ${topicFilesDir}/${topicName}/prompt-queue.md`);
  }
} catch (e) {
  log(`prompt-queue.md seed skipped: ${e.message}`);
}

// ---------- Register topic-id; auto-bump any displaced topic to a fresh id ----------
// Update global-config.json: add to topic-ids map.
const displacedTopic = topicIds[numericId];
if (displacedTopic && displacedTopic !== topicName) {
  const usedIds = Object.keys(topicIds).map(Number).filter(n => !isNaN(n));
  const newId = String(Math.max(...usedIds) + 1);
  topicIds[newId] = displacedTopic;
  log(`ID ${numericId} taken from "${displacedTopic}" — auto-assigned ID ${newId} to "${displacedTopic}"`);
}
topicIds[numericId] = topicName;

// Minimal topic-config.json. Every key present in `global-config.json` is
// INTENTIONALLY stripped from the seed so the cascade reads global → topic →
// run. To override a global value for this topic, the user copies that key
// here. The header comment below makes that contract explicit on first sight
// (QA gap 4 — was previously implicit and frequently misunderstood).
const HEADER_COMMENT = [
  'Override-only config. Any key present in global-config.json is omitted',
  'here on purpose — leaving it absent means the topic inherits the global',
  'value. To override a global key for THIS topic, copy that key from',
  'global-config.json into this file (preserve key name verbatim). Anything',
  'NOT in global-config.json may live here as a topic-only setting.',
].join(' ');

// ---------- Override-only seed: strip keys already present in global so cascade works ----------
function stripGloballyDefinedKeys(seed, globalCfg) {
  if (!globalCfg) return seed;
  const out = {};
  for (const k of Object.keys(seed)) {
    // Always keep meta comment + identity keys.
    if (k.startsWith('//') || k === 'topic-id' || k === 'prompt-file') { out[k] = seed[k]; continue; }
    if (k in globalCfg) continue; // strip — let it cascade
    out[k] = seed[k];
  }
  return out;
}

const seedTopicConfig = {
  '// README': HEADER_COMMENT,
  'topic-id': numericId,
  'prompt-file': `${topicName}.md`,
};
const topicConfig = stripGloballyDefinedKeys(seedTopicConfig, config);

const topicConfigPath = path.join(topicDir, configUtils.TOPIC_CONFIG_FILENAME);
configUtils.writeConfig(topicConfigPath, topicConfig);
log(`Created: ${topicFilesDir}/${topicName}/${configUtils.TOPIC_CONFIG_FILENAME}`);

// ---------- First-run hook: install shell aliases (hrun/etc), one-shot self-disable ----------
if (config['auto-install-shell-functions'] !== false && config.autoInstallShellFunctions !== false) {
  try {
    const { install } = require('./install-shell-functions.js');
    const res = install({ force: false });
    if (res && res.ok) {
      config['auto-install-shell-functions'] = false;
      log('Shell functions installed — auto-install-shell-functions flipped to false.');
    } else {
      log(`Shell function install reported failure (${res && res.reason || 'unknown'}); leaving auto-install-shell-functions=true and continuing.`);
    }
  } catch (e) {
    log(`Shell function install failed (${e.message}); leaving auto-install-shell-functions=true and continuing.`);
  }
}

// ---------- Persist global config + update .last-topic pointer + print run hint ----------
configUtils.writeConfig(configPath, config);
releaseConfigLock();
log(`global-config.json updated — topic "${topicName}" registered as ID ${numericId}`);

const lastTopicPath = path.join(HARNESS, '.last-topic');
fs.writeFileSync(lastTopicPath, topicName, 'utf8');
log(`.last-topic set to "${topicName}"`);
log(`Done. Write your task under "## User Prompt" in ${topicFilesDir}/${topicName}/${topicName}.md, then run:`);
log(`  node Agent_Orchestrator/run-agent.js ${numericId} coding`);
