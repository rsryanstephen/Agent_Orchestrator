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
const [, , topicName, idArg, rootRepoArg] = process.argv;
if (!topicName) {
  die('Usage: node Agent_Orchestrator/start-topic.js <topic-name> [numerical-id] [root-repo]\n\n  Example: node Agent_Orchestrator/start-topic.js user-auth 2 ../my-service');
}

// ---------- Resolve root-repo: 3rd positional arg sets the working/scan root for all
// agents on this topic. Accept absolute or relative input; relative paths resolve against
// the directory hstartt was invoked from (process.cwd()). Omitted/blank -> default cwd. ----------
// `{}` is the harness empty-arg placeholder (same sentinel honored for idArg above).
// Log the cwd fallback when an explicit-but-empty value is passed, mirroring idArg's warn.
let rootRepo;
if (rootRepoArg && rootRepoArg.trim() && rootRepoArg !== '{}') {
  rootRepo = path.isAbsolute(rootRepoArg) ? rootRepoArg : path.resolve(process.cwd(), rootRepoArg);
} else {
  if (rootRepoArg && rootRepoArg !== '{}') log(`Blank root-repo "${rootRepoArg}" — defaulting to cwd: ${process.cwd()}`);
  rootRepo = process.cwd();
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
    // root-repo is a topic-only key (never in global-config); keep it unconditionally
    // so the per-topic working/scan root always survives the strip even if a user later
    // adds a root-repo default to global-config.json.
    if (k.startsWith('//') || k === 'topic-id' || k === 'prompt-file' || k === 'root-repo') { out[k] = seed[k]; continue; }
    if (k in globalCfg) continue; // strip — let it cascade
    out[k] = seed[k];
  }
  return out;
}

// Seed root-repo into the topic config: this is the absolute filesystem root every
// agent runs git against, resolves context-files relative paths from, and spawns the
// provider CLI inside (see run-agent.js repoRoot).
const seedTopicConfig = {
  '// README': HEADER_COMMENT,
  'topic-id': numericId,
  'prompt-file': `${topicName}.md`,
  'root-repo': rootRepo,
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

// Atomic write of `.last-topic`: a plain writeFileSync interrupted mid-call
// can leave the file truncated to 0 bytes, after which `hrun` proceeds without
// a topic. Route through atomicWriteText so the file is always either the
// previous value or the new value, never empty.
const lastTopicPath = path.join(HARNESS, '.last-topic');
const { atomicWriteText } = require('./lib/safe-json-write');
atomicWriteText(lastTopicPath, topicName);
log(`.last-topic set to "${topicName}"`);
// Encourage the user to scope agent work: root-repo sets where agents operate, and
// populating context-files narrows their attention so they check known locations
// FIRST instead of scanning the whole repo.
log(`root-repo set to "${rootRepo}" — all agents for this topic run against that directory.`);
log(`TIP: edit ${topicFilesDir}/${topicName}/${configUtils.TOPIC_CONFIG_FILENAME} and add the files/folders most relevant to this topic under "context-files" — agents read those FIRST, so it focuses their work and avoids wasteful full-repo scans.`);
log(`Done. Write your task under "## User Prompt" in ${topicFilesDir}/${topicName}/${topicName}.md, then run:`);
log(`  node Agent_Orchestrator/run-agent.js ${numericId} coding`);
