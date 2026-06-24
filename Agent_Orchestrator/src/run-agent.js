#!/usr/bin/env node
/**
 Agent orchestration runner — single-file-per-topic architecture.
 Usage: node Agent_Orchestrator/run-agent.js [<topic|id>] <command>
        Topic is optional after first use — last topic is saved to .last-topic.

 Each topic has ONE markdown history file derived as <topic-files-dir>/<topic>/<topic>.md.
 All agent responses stream into that file with role-prefixed headers:
   ## Planning Agent Response
   ## Coding Agent Response
   ## Assessment Agent Response
   ## Coding Agent Response (Remediation)
   ## Ask Agent Response
 A single "## User Prompt" suffix is appended at the very end of a run (or pipeline).

 planning               – produces an implementation plan, appends ## Planning Agent Response
 coding                 – executes the task, appends ## Coding Agent Response
 assessment             – reviews changes, appends ## Assessment Agent Response
 fix                    – reads latest ## Assessment Agent Response, fixes code, appends ## Coding Agent Response (Remediation)
 ask                    – answers question using codebase context (read-only), appends ## Ask Agent Response
 assess-fix   (af)      – assessment → fix
 plan-code    (pc)      – planning → coding (coding executes the plan output)
 code-assess-fix (caf)  – coding → assessment → fix
 ask-code     (ac)      – ask → coding (answers question then executes coding phase)
 all                    – planning → coding → assessment → fix

 Shorthands: p=planning, c=coding, a=ask, ac=ask-code, f=fix, af=assess-fix, pc=plan-code, caf=code-assess-fix

Shell helpers (see README.md) delegate to this script.
**/

'use strict';

// =========================================================================
// Module imports + path roots + canonical constants (pipeline phase tables,
// model tier maps, role-header labels). No side effects beyond `require`.
// =========================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const configUtils = require('./config-utils');
// Shared keystroke-based editor flush (default mechanism). Imported so the main
// pipeline's flushEditorBuffers and the parallel/auto-resume entry points use one
// keystroke-flush implementation (hardcoded, non-configurable).
// Import FLUSHED_ENV alongside flushViaKeystroke so this in-process copy honours
// the same cross-process guard the entry-point flush sets — a spawned child must
// not re-fire the keystroke chord (double focus-steal) when an ancestor already
// flushed before spawning it.
const { flushViaKeystroke, FLUSHED_ENV } = require('./editor-buffer-flush');
const { splitPromptIntoTasks, parsePlanningSubtasks, nextPlannedSubtasksFromPlan, roleHeaderFor, ROLE_HEADER: ROLE_HEADER_LIB } = require('./lib/fan-out');
const { getProvider } = require('./lib/providers/registry');
// classifyTokensExhausted added to drive cross-provider fallback chain:
// quota errors from non-Claude providers carry no rate-reset clock, so this
// detector triggers the swap without depending on err.tokenReset.
const { classifyTokenError, classifyTokensExhausted } = require('./lib/token-error');
const { getAdvisorFlags } = require('./lib/advisor-flags');

const ROOT = path.join(__dirname, '..', '..');
const HARNESS = path.join(__dirname, '..');
// 'ask' answers questions without modifying files; 'ask-code' asks then runs coding phase.
const VALID_ROLES = ['planning', 'coding', 'assessment', 'fix', 'assess-fix', 'plan-code', 'code-assess-fix', 'all', 'continue', 'ask', 'ask-code'];

// Pipeline phases per command (used by dispatch + state-driven resume + continue).
// ask: answers question only; ask-code: answers question then runs coding phase.
const PIPELINES = {
  planning: ['planning'],
  coding: ['coding'],
  assessment: ['assessment'],
  fix: ['fix'],
  'assess-fix': ['assessment', 'fix'],
  'plan-code': ['planning', 'coding'],
  'code-assess-fix': ['coding', 'assessment', 'fix'],
  'all': ['planning', 'coding', 'assessment', 'fix'],
  ask: ['ask'],
  'ask-code': ['ask', 'coding'],
};
// Updated to claude-opus-4-8 per models-reference.md refresh (4-7 is superseded).
const LATEST_OPUS = 'claude-opus-4-8';
const LATEST_SONNET = 'claude-sonnet-4-6';
const LATEST_HAIKU = 'claude-haiku-4-5-20251001';

// Static fallback tiers used when the model-catalog cache is absent or stale.
// Keys are the harness provider ids; tiers map to prompt-complexity buckets.
const _PROVIDER_AUTO_MODELS_STATIC = {
  'claude-code':    { light: LATEST_HAIKU,         medium: LATEST_SONNET,    heavy: LATEST_OPUS },
  // Copilot CLI GA (Feb 2026) rejects gpt-4o ids; gpt-5/gpt-5-mini are also unavailable.
  // gpt-4.1 family is the last confirmed-working GPT tier per user directive.
  'github-copilot': { light: 'gpt-4.1-mini',        medium: 'gpt-4.1',        heavy: 'gpt-4.1' },
  // Gemini CLI GA: 2.0-flash deprecated; use 2.5-flash for light tier per user directive.
  'gemini':         { light: 'gemini-2.5-flash',   medium: 'gemini-2.5-pro', heavy: 'gemini-2.5-pro' },
  'gemini-vertex':  { light: 'gemini-2.5-flash',   medium: 'gemini-2.5-pro', heavy: 'gemini-2.5-pro' },
};

// One-time warn + background-fetch flags; reset per process so parallel child processes each warn once.
let _cacheWarnEmitted = false;
let _cacheFetchStarted = false;

// Reads .model-catalog-cache.json (written by model-catalog.js / hfetch-models) and
// returns cached tiers for the given provider if the cache is present and fresher than
// 30 days. Falls back to the static map entry above — never throws.
// On cache miss, fires a background resolveProviderTiers call (no-await) to warm the
// cache for the next invocation, wiring the async auto-fetch path that was previously dead.
function _loadProviderTiers(providerId) {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const cachePath = path.join(HARNESS, '.model-catalog-cache.json');
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const cache = JSON.parse(raw);
    const age = Date.now() - (cache.fetchedAt || 0);
    if (age <= THIRTY_DAYS_MS) {
      const entry = cache.providers && cache.providers[providerId];
      if (entry && entry.tiers) {
        return entry.tiers;
      }
    }
  } catch (_) {
    // Cache absent, unreadable, or corrupt — fall through to static.
  }
  // Emit warn at most once per process to avoid spamming on every resolveModel/autoClassifyModel call.
  if (!_cacheWarnEmitted) {
    _cacheWarnEmitted = true;
    console.warn('[model-catalog] cache miss — run hfetch-models to warm');
  }
  // Wire resolveProviderTiers: kick off background fetch so next run finds a warm cache.
  // Fire-and-forget — current run uses static fallback; next run uses live-fetched tiers.
  if (!_cacheFetchStarted) {
    _cacheFetchStarted = true;
    try {
      const { resolveProviderTiers } = require('./lib/model-catalog');
      resolveProviderTiers(providerId).catch(() => {});
    } catch (_) {}
  }
  return _PROVIDER_AUTO_MODELS_STATIC[providerId] || { light: null, medium: null, heavy: null };
}
const touchedDirs = new Set();
const LOCK_PATH = path.join(__dirname, '..', '.global-config.lock');
const DEFAULT_MAX_CONCURRENT_AGENTS = 4;

// Role → header label written into the single history file (canonical labels from lib/fan-out.js).
const ROLE_HEADER = ROLE_HEADER_LIB;

// Pattern that recognises ANY agent-response header (any role + optional " N" agent number + optional " (Remediation)" suffix).
// Also tolerates legacy "(task-N)" suffix from prior runs.
const ANY_RESPONSE_HEADER = '(?:Planning|Coding|Assessment)\\s+Agent(?:\\s+\\d+)?\\s+Response(?:\\s*\\(Remediation(?:\\s+task-\\d+)?\\))?(?:\\s*\\(task-\\d+\\))?';

// roleHeaderFor, splitPromptIntoTasks, parsePlanningSubtasks imported from ./lib/fan-out

// =========================================================================
// Logging + sleep + file-lock primitives. PID-stamped lockfiles tolerate
// stale owners via `process.kill(pid, 0)` liveness probes.
// =========================================================================
function log(msg) { console.log(msg); }
// Central fatal-exit helper. Now also fires the error sound before exiting so
// every die() path is audible. playErrorSound is a hoisted function declaration,
// so the forward reference resolves at call time; try/catch guards the early-load
// case where sound config/deps are not ready and prevents a sound failure from
// masking the real error. Master-switch + error-sound-file gating lives inside
// _playSoundFile, so no extra gate is needed here.
function die(msg) { console.error(`ERROR: ${msg}`); try { playErrorSound(); } catch {} process.exit(1); }

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireConfigLock() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
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

function acquireTopicConfigLock(topicLockPath) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { fs.writeFileSync(topicLockPath, String(process.pid), { flag: 'wx' }); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const ownerPid = parseInt(fs.readFileSync(topicLockPath, 'utf8'), 10);
        try { process.kill(ownerPid, 0); } catch { fs.unlinkSync(topicLockPath); continue; }
      } catch {}
      sleepMs(100);
    }
  }
  die(`Timed out waiting for topic-config.json lock at ${topicLockPath}`);
}
function releaseTopicConfigLock(topicLockPath) { try { fs.unlinkSync(topicLockPath); } catch {} }

function releaseConfigLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}
process.on('exit', releaseConfigLock);

function acquireFileLock(targetPath) {
  const lockPath = targetPath + '.lock';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const ownerPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        try { process.kill(ownerPid, 0); } catch { fs.unlinkSync(lockPath); continue; }
      } catch {}
      sleepMs(100);
    }
  }
  die(`Timed out waiting for file lock on ${targetPath}`);
}

function releaseFileLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch {}
}

// ── Per-topic resume state (`.state/<topic>.json`) ────────────────────────────

// =========================================================================
// .state directory: per-topic resume state, active-topic registry, wake
// queue + diagnostic logs. Survives process death — auto-resume reads it.
// =========================================================================
const STATE_DIR = path.join(HARNESS, '.state');
function statePathFor(topicName) { return path.join(STATE_DIR, `${topicName}.json`); }

// ── Active-topics registry (shared with sibling run-parallel children) ────────

const ACTIVE_TOPICS_PATH = path.join(STATE_DIR, 'active-topics.json');

// Live agents re-assert themselves every REFRESH_MS; an entry whose lastSeen is
// older than TTL_MS is treated as stale even if its pid still probes alive. This
// is the spawn-token / heartbeat that closes the Windows PID-reuse hole (a dead
// agent's pid can be recycled by an unrelated process, defeating kill(pid,0)).
const ACTIVE_TOPIC_REFRESH_MS = 15000;
const ACTIVE_TOPIC_TTL_MS = 60000;

// Liveness probe: a registry entry is stale if its owning process is gone.
// process.kill(pid, 0) throws ESRCH for a dead pid. EPERM means the process
// EXISTS but is owned by another user — treat that as ALIVE so we never prune a
// live sibling. Treat our own pid as always alive.
function _isPidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// Read active topics for the heartbeat display. Drops entries whose owning
// process is dead (process.on('exit') misses SIGKILL/hard exits, so stale
// dead-pid entries otherwise accumulate forever and inflate the topic list),
// then dedupes by name so the same topic isn't printed dozens of times.
function readActiveTopics() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACTIVE_TOPICS_PATH, 'utf8'));
    if (!Array.isArray(raw.topics)) return [];
    const seen = new Set();
    const names = [];
    const now = Date.now();
    for (const t of raw.topics) {
      if (!t || !t.name || !_isPidAlive(t.pid)) continue;
      // PID-reuse guard: kill(pid,0) can report a recycled pid as alive, so an
      // entry whose heartbeat (lastSeen) has gone stale is dropped regardless.
      // Legacy entries without lastSeen fall back to the pid-only check.
      if (typeof t.lastSeen === 'number' && now - t.lastSeen > ACTIVE_TOPIC_TTL_MS) continue;
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      names.push(t.name);
    }
    return names;
  } catch { return []; }
}

// Register this process's topic. Self-heals the registry under lock by pruning
// both this pid's prior entry AND any dead-pid entries left behind by crashed
// siblings, preventing unbounded growth of the active-topics file.
function registerActiveTopic(topicName) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = acquireFileLock(ACTIVE_TOPICS_PATH);
  try {
    let state = { topics: [] };
    try { state = JSON.parse(fs.readFileSync(ACTIVE_TOPICS_PATH, 'utf8')); } catch {}
    if (!Array.isArray(state.topics)) state.topics = [];
    // Self-heal: drop this pid's prior entry, dead-pid entries, AND entries whose
    // heartbeat has gone stale (TTL) so a recycled pid can't keep a ghost alive.
    const now = Date.now();
    state.topics = state.topics.filter(t => t && t.pid !== process.pid && _isPidAlive(t.pid)
      && !(typeof t.lastSeen === 'number' && now - t.lastSeen > ACTIVE_TOPIC_TTL_MS));
    state.topics.push({ name: topicName, pid: process.pid, started: now, lastSeen: now });
    fs.writeFileSync(ACTIVE_TOPICS_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } finally { releaseFileLock(lock); }
}

// Refresh this process's lastSeen under lock so a long-running agent stays fresh.
// A recycled pid never runs this against our entry, so the stale entry ages out
// via the TTL check in readActiveTopics — eliminating PID-reuse ghosts.
function touchActiveTopic() {
  try {
    if (!fs.existsSync(ACTIVE_TOPICS_PATH)) return;
    const lock = acquireFileLock(ACTIVE_TOPICS_PATH);
    try {
      let state = { topics: [] };
      try { state = JSON.parse(fs.readFileSync(ACTIVE_TOPICS_PATH, 'utf8')); } catch {}
      if (!Array.isArray(state.topics)) return;
      const mine = state.topics.find(t => t && t.pid === process.pid);
      if (!mine) return;
      mine.lastSeen = Date.now();
      fs.writeFileSync(ACTIVE_TOPICS_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } finally { releaseFileLock(lock); }
  } catch {}
}

function unregisterActiveTopic() {
  try {
    if (!fs.existsSync(ACTIVE_TOPICS_PATH)) return;
    const lock = acquireFileLock(ACTIVE_TOPICS_PATH);
    try {
      let state = { topics: [] };
      try { state = JSON.parse(fs.readFileSync(ACTIVE_TOPICS_PATH, 'utf8')); } catch {}
      if (!Array.isArray(state.topics)) state.topics = [];
      state.topics = state.topics.filter(t => t && t.pid !== process.pid);
      fs.writeFileSync(ACTIVE_TOPICS_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } finally { releaseFileLock(lock); }
  } catch {}
}
process.on('exit', unregisterActiveTopic);

function loadResumeState(topicName) {
  const p = statePathFor(topicName);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Holds the active per-prompt `## User Prompt` header model/provider override
// (set at dispatch when a header is recognised). Module-level so the per-phase
// `saveResumeState` writes below can fold it into the persisted resume state.
let _promptHeaderResumeOverride = null;

function saveResumeState(topicName, state) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  // Persist any active per-prompt header model/provider into the resume state.
  // The header line is physically stripped from history on first dispatch, so a
  // later auto-resume cannot re-parse it; without this the resumed run silently
  // reverts to the default model/provider. (QA: resume-loses-header-overrides.)
  const _ov = _promptHeaderResumeOverride;
  const merged = (_ov && (_ov.model || _ov.provider))
    ? { ...state, headerModel: _ov.model || undefined, headerProvider: _ov.provider || undefined }
    : state;
  fs.writeFileSync(statePathFor(topicName), JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

function clearResumeState(topicName) {
  try { fs.unlinkSync(statePathFor(topicName)); } catch {}
}

// ── Shared wake queue for auto-resume after token reset ───────────────────────

const WAKE_QUEUE_PATH = path.join(STATE_DIR, 'wake-queue.json');
const AUTO_RESUME_LOG = path.join(STATE_DIR, 'auto-resume.log');
const AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG = path.join(STATE_DIR, 'auto-answer-clarifying-questions-debug.log');
const AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH = path.join(STATE_DIR, 'auto-answer-clarifying-questions-failures.json');

function appendAutoResumeLog(msg, err) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [run-agent.js] ${msg}`;
    if (err) line += `\n  ERROR: ${err.message}\n  STACK: ${(err.stack || err.message).split('\n').join('\n  ')}`;
    fs.appendFileSync(AUTO_RESUME_LOG, line + '\n', 'utf8');
  } catch {}
}

// Cap debug log at this size; on overflow, rotate to .1 (single-generation, overwrite).
const AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateAutoAnswerClarifyingQuestionsDebugLogIfNeeded() {
  try {
    const st = fs.statSync(AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG);
    if (st.size >= AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG_MAX_BYTES) {
      const rotated = AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG + '.1';
      try { fs.unlinkSync(rotated); } catch {}
      try { fs.renameSync(AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG, rotated); } catch {}
    }
  } catch {}
}

let _autoAnswerClarifyingQuestionsDebugPathLogged = false;
function appendAutoAnswerClarifyingQuestionsDebug(entry) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    if (!_autoAnswerClarifyingQuestionsDebugPathLogged) {
      _autoAnswerClarifyingQuestionsDebugPathLogged = true;
      try { log(`auto-answer-clarifying-questions debug log path: ${path.resolve(AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG)}`); } catch {}
    }
    rotateAutoAnswerClarifyingQuestionsDebugLogIfNeeded();
    const ts = new Date().toISOString();
    const topicName = entry.topic || '<unknown>';
    const label = entry.label || '<unlabeled>';
    const expected = entry.expectedCount != null ? entry.expectedCount : '?';
    const answered = Array.isArray(entry.answeredIndices) ? entry.answeredIndices.join(',') : '';
    const header = `[${ts}] topic=${topicName} label=${label} expectedCount=${expected} answeredIndices=[${answered}]`;
    const extras = entry.note ? `  note: ${entry.note}\n` : '';
    const raw = entry.text != null ? entry.text : '';
    const block = `${header}\n${extras}  raw:\n\`\`\`\n${raw}\n\`\`\`\n`;
    fs.appendFileSync(AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG, block + '\n', 'utf8');
  } catch {}
}

function appendQueueInjectDebug(entry) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    rotateAutoAnswerClarifyingQuestionsDebugLogIfNeeded();
    const ts = new Date().toISOString();
    const branch = entry.branch || '<unknown>';
    const matched = entry.matched != null ? String(entry.matched) : '?';
    const tailLen = entry.tailLen != null ? entry.tailLen : '?';
    const tailHex = entry.tailHex || '';
    const tailRaw = entry.tailRaw != null ? entry.tailRaw : '';
    const header = `[${ts}] queue-inject branch=${branch} matched=${matched} tailLen=${tailLen}`;
    // Use sentinel delimiters (not ``` fences) so a tail containing triple-backticks
    // does not fragment the log block.
    const tailRawSafe = String(tailRaw).replace(/\r/g, '\\r');
    const block = `${header}\n  tailHex(last80): ${tailHex}\n  tailRaw(last80) <<<RAW\n${tailRawSafe}\nRAW>>>\n`;
    fs.appendFileSync(AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_LOG, block + '\n', 'utf8');
  } catch {}
}

function incrementAutoAnswerClarifyingQuestionsFailures(topicName, missingCount) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    let obj = {};
    try { obj = JSON.parse(fs.readFileSync(AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH, 'utf8')) || {}; } catch {}
    const cur = obj[topicName] || { failures: 0, missingTotal: 0, lastAt: null };
    cur.failures += 1;
    cur.missingTotal += missingCount;
    cur.lastAt = new Date().toISOString();
    obj[topicName] = cur;
    fs.writeFileSync(AUTO_ANSWER_CLARIFYING_QUESTIONS_FAILURES_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch {}
}
// =========================================================================
// Token-reset + network-error pattern detection from provider output buffers.
// Drives wake-queue scheduling (sleep until rate-limit window resets).
// =========================================================================
const TOKEN_RESET_REGEX = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;

function detectTokenResetFromBuffer(buf) {
  const m = (buf || '').match(TOKEN_RESET_REGEX);
  if (!m) return null;
  return {
    hour: parseInt(m[1], 10),
    minute: m[2] ? parseInt(m[2], 10) : 0,
    ampm: m[3] ? m[3].toLowerCase() : null,
    tz: m[4] ? m[4].trim() : null,
  };
}

const NETWORK_ERROR_REGEX = /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|network (?:error|unavailable|is unreachable)|socket hang up|TLS (?:handshake|connection)|connect ECONN|Unable to (?:reach|connect)|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i;

function detectNetworkErrorFromBuffer(buf) {
  if (!buf) return false;
  // Don't classify token-limit messages as network errors (token-limit has dedicated handler).
  if (TOKEN_RESET_REGEX.test(buf)) return false;
  return NETWORK_ERROR_REGEX.test(buf);
}

// =========================================================================
// Wake-queue scheduling: schedule schtasks/at jobs to invoke auto-resume.js
// at the next token-reset instant, batched across all paused topics.
// =========================================================================
function nextResetInstant({ hour, minute, ampm }) {
  let hh;
  if (ampm) hh = (hour % 12) + (ampm === 'pm' ? 12 : 0);
  else hh = hour;
  if (hh < 0 || hh > 23 || minute < 0 || minute > 59) return null;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

// Append job under lock and report whether this caller became the new "earliest"
// (the only one that should invoke schtasks/at). Prevents parallel topics from racing.
function enqueueWake(topicName, pipelineName, phaseIndex, resetInstantMs) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = acquireFileLock(WAKE_QUEUE_PATH);
  try {
    let queue = { earliest: null, jobs: [] };
    if (fs.existsSync(WAKE_QUEUE_PATH)) {
      try { queue = JSON.parse(fs.readFileSync(WAKE_QUEUE_PATH, 'utf8')); } catch {}
    }
    queue.jobs.push({ topic: topicName, pipeline: pipelineName, phaseIndex, resetMs: resetInstantMs });
    const prevEarliest = queue.earliest;
    const becameEarliest = (prevEarliest == null) || (resetInstantMs < prevEarliest);
    queue.earliest = becameEarliest ? resetInstantMs : prevEarliest;
    fs.writeFileSync(WAKE_QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n', 'utf8');
    return becameEarliest;
  } finally {
    releaseFileLock(lock);
  }
}

// `scheduleSharedWake` and the OS-level scheduled-task plumbing were removed
// when the detached-auto-resume config option was deleted — inline countdown is
// now the only token-limit recovery path, so no OS wake task is registered.
// `enqueueWake` is retained: the network-error branch still writes resume
// metadata that `auto-resume.js` (`hresume`) consumes on manual re-run.

// =========================================================================
// Concurrency / fleet sizing helpers + parallel-coding brief-header builder.
// =========================================================================
function getMaxConcurrentAgents() {
  // Delegate to the pure scope-specificity resolver in config-utils so the
  // topic-over-global precedence (across both the new and legacy keys) is
  // unit-testable without spawning the CLI. Bug fixed: a GLOBAL
  // `max-parallel-agents-per-topic` previously shadowed a TOPIC
  // `max-concurrent-agents`.
  return configUtils.resolveMaxConcurrentAgents(topicConfig, config, DEFAULT_MAX_CONCURRENT_AGENTS);
}

function getParallelAssessmentAgents() {
  // Default false: assessment + fix stay serial even when coding fanned out.
  // Delegate to the pure resolver in config-utils so the documented
  // topic-over-global, true/"true"-only behaviour is unit-testable.
  return configUtils.resolveParallelAssessmentAgents(topicConfig, config);
}

function buildParallelCodingBriefHeader(taskCount) {
  if (!taskCount || taskCount <= 1) return '';
  const historyContent = fs.readFileSync(historyPath, 'utf8');
  const summaries = [];
  for (let i = 1; i <= taskCount; i++) {
    const re = new RegExp(`^##+\\s*Coding Agent (?:${i} Response|Response \\(task-${i}\\))\\s*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`, 'im');
    const m = historyContent.match(re);
    summaries.push(`### task-${i} summary\n${m ? m[1].trim() : '(no summary captured)'}`);
  }
  return `Parallel coding run: ${taskCount} coding agents touched the working tree concurrently. The combined \`git diff\` contains all of their changes. Match findings by file/intent rather than assuming ownership of any single hunk.\n\n## Sibling Coding-Agent Summaries (all parallel tasks)\n${summaries.join('\n\n')}\n\n`;
}

// splitPromptIntoTasks and parsePlanningSubtasks are imported from ./lib/fan-out

// =========================================================================
// History-file IO: init, latest-section parsing, conversation-context
// extraction, sanitization, snapshot diffing, divider stripping.
// =========================================================================
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function initHistoryFile(filePath, topicName) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# ${topicName} - chat history\n\n## User Prompt\n`, 'utf8');
  }
}

function parseLatestSection(filePath, headerPattern) {
  const content = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`^##\\s+${headerPattern}[^\\n]*$`, 'gim');
  let lastMatch = null;
  let m;
  while ((m = re.exec(content)) !== null) lastMatch = m;
  if (!lastMatch) return null;
  const tail = content.slice(lastMatch.index + lastMatch[0].length);
  // Stop at the next "## " header (any kind), else end-of-file.
  const nextHeader = tail.search(/^##\s+/m);
  const body = nextHeader >= 0 ? tail.slice(0, nextHeader) : tail;
  return body.replace(/\n---\s*$/, '').trim() || null;
}

function parseConversationContext(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const OLD_CLEAR = '--- CLEAR CONTEXT ---';
  const NEW_CLEAR = '<!-- CLEAR CONTEXT -->';
  const oldIdx = content.lastIndexOf(OLD_CLEAR);
  const newIdx = content.lastIndexOf(NEW_CLEAR);
  let lastClearIdx, clearMarker;
  if (newIdx >= oldIdx) { lastClearIdx = newIdx; clearMarker = NEW_CLEAR; }
  else { lastClearIdx = oldIdx; clearMarker = OLD_CLEAR; }
  const raw = lastClearIdx >= 0 ? content.slice(lastClearIdx + clearMarker.length) : content;

  const MASK = '\x00##';
  const masked = raw.replace(/`{3}[\s\S]*?`{3}/g, block => block.replace(/^##/gm, MASK));

  // Allow an optional `(...)` suffix on User Prompt headers ONLY (e.g. `## User Prompt (From the Queue)`).
  // Without this, `injectQueuedPromptIntoHistory`'s tagged headers go unrecognised, the slice anchors
  // on the prior bare `## User Prompt`, and the planning agent receives a stale prompt.
  // Suffix is scoped to `User Prompt` so existing response-header alternations (which already encode
  // their own optional `(Remediation ...)` / `(task-N)` variants in ANY_RESPONSE_HEADER) keep their
  // prior split semantics — preventing accidental new split-points in downstream consumers.
  const headerSplit = new RegExp(`^(##\\s+(?:User Prompt(?:\\s+\\([^)\\n]*\\))?|User Reply to Questions|Auto Reply to Clarifying Questions|Auto Answer|${ANY_RESPONSE_HEADER}))\\s*$`, 'gim');
  let parts = masked.split(headerSplit);
  // Intentionally NO archive fallback here. Archived `## User Prompt` blocks
  // must NOT surface through this path — downstream dispatchers (`runPlanning`,
  // `runCoding`) treat trailing parsed blocks as actionable, so resurrecting
  // a stale archive prompt would cause re-execution. The dedicated
  // `buildHistoryPreamble` path supplies archived RESPONSES (read-only,
  // context-only) for stateless providers — keep the two paths independent
  // to avoid both stale-prompt resurrection AND double-injection of the same
  // archived responses (once as preamble, once as parsed context).
  if (parts.length < 3) return null;

  let blocks = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const header = parts[i].trim();
    const text = parts[i + 1].replace(/\x00##/g, '##').replace(/\n---\s*$/, '').trim();
    if (text) blocks.push({ header, text });
  }

  if (!blocks.some(b => /user prompt/i.test(b.header))) return null;

  // Drop everything BEFORE the LATEST `## User Prompt` block so downstream agents
  // never respond to stale prompts. Keep the latest prompt + all subsequent blocks
  // (User Reply to Questions, agent responses, etc.) so current-turn context is intact.
  let lastUserPromptIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (/^##\s+User Prompt\b/i.test(blocks[i].header.trim())) lastUserPromptIdx = i;
  }
  if (lastUserPromptIdx >= 0) blocks = blocks.slice(lastUserPromptIdx);

  return blocks.map(block => {
    let text = block.text;
    if (/agent response/i.test(block.header)) {
      // Strip only the trailing *Model: ...* footer; full body now ships untruncated
      // because prior-turn lookup is handled lazily by the history-self-lookup skill.
      text = text.replace(/\n\n\*Model:[\s\S]*?\*\s*$/, '');
    }
    return `${block.header}\n\n${text}`;
  }).join('\n\n');
}

// =========================================================================
// history-self-lookup skill wiring: load the approved SKILL.md, strip its
// YAML frontmatter, and substitute the runtime placeholders so MAIN-role
// agents fetch prior-turn context lazily via `Read` instead of relying only
// on the parsed current-turn dump. Returns '' when the skill file is missing
// so payload builders degrade gracefully. Parallel fan-out paths intentionally
// do NOT call this — their subtask prompts stay deterministic/self-contained.
// =========================================================================
function buildHistorySelfLookupBlock(historyFilePath) {
  const skillPath = path.join(__dirname, '..', 'skills', 'history-self-lookup', 'SKILL.md');
  let body;
  try { body = fs.readFileSync(skillPath, 'utf8'); }
  catch { return ''; }
  // Strip leading YAML frontmatter so only the instructional body ships to the agent.
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Resolve absolute history path + line count via Node fs (not shell) for the Read offset hint.
  const absHistory = path.resolve(historyFilePath);
  let lineCount = 0;
  try { lineCount = fs.readFileSync(absHistory, 'utf8').split('\n').length; }
  catch { lineCount = 0; }
  // Queue file sits beside the history file as prompt-queue.md.
  const absQueue = path.join(path.dirname(absHistory), 'prompt-queue.md');
  body = body
    .replace(/<promptHistoryFile>/g, absHistory)
    .replace(/<historyLineCount>/g, String(lineCount))
    .replace(/<queueFile>/g, absQueue);
  return `## History Self-Lookup (skill)\n\n${body.trim()}\n\n`;
}

function stripTrailingUserPrompt(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Match the trailing empty `## User Prompt` block whether or not it has a leading `---` divider.
  const stripped = content.replace(/(?:\n+(?:---\s*\n+)?)## User Prompt\s*\n*$/, '');
  if (stripped !== content) fs.writeFileSync(filePath, stripped, 'utf8');
}

function sanitizeForAppend(content) {
  // Strip trailing dash-only lines so they don't form a Setext H2 under the next entry's footer/header.
  // Preserve a single trailing newline so the file always ends in `\n` (avoids `\ No newline at end of file` regression).
  let out = content.replace(/(?:\n[ \t]*-{3,}[ \t]*)+\s*$/g, '').replace(/\s+$/g, '');
  // Collapse stacked `*Model: ...*` italic footers at the tail down to the LAST one only.
  // Prevents duplicate footer regression when callers concatenate a fresh footer onto agent
  // text that already echoes a prior run's footer.
  while (true) {
    const m = out.match(/\*Model:[^\n*]*\*\s*\n+(?=\*Model:[^\n*]*\*\s*$)/);
    if (!m) break;
    out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
  }
  return out;
}

function snapshotHistorySize() {
  // Flush any unsaved VS Code editor buffers BEFORE measuring so a user mid-edit
  // gets folded into the baseline and isn't clobbered by post-phase truncation.
  try { saveAllVsCodeBuffers(); } catch {}
  try {
    const buf = fs.readFileSync(historyPath);
    return { size: buf.length, hash: crypto.createHash('sha256').update(buf).digest('hex'), content: buf };
  } catch { return { size: 0, hash: null, content: null }; }
}

function truncateHistoryIfAgentWrote(before, label = '') {
  // Size-only growth check. Never restore stale prefix content — that wipes user edits
  // made mid-phase (e.g. edits to `## User Reply to Questions`) and resurrects already-
  // compacted/truncated tail blocks like a stale `## User Prompt` or `## Compressed History`.
  const snap = (before && typeof before === 'object') ? before : { size: before || 0 };
  const lock = acquireFileLock(historyPath);
  try {
    let buf;
    try { buf = fs.readFileSync(historyPath); } catch { return; }
    if (buf.length > snap.size) {
      // Concurrency guard (missing-prompt bug, 2026-06-18 `opus caf`/header-prompt
      // loss). A SIBLING process can serially dequeue + `injectQueuedPromptIntoHistory`
      // a real `## User Prompt (From the Queue)` block into the tail in the window
      // between this phase's `snapshotHistorySize()` and this truncate. A blind
      // `ftruncate` to `snap.size` then deletes that freshly-injected prompt (and any
      // response written under it) — the exact observed permanent loss. Refuse to
      // discard a tail that introduces a NEW `## User Prompt` header; leave the file
      // intact so the concurrently-injected prompt survives. Agents are forbidden
      // from writing the history file themselves, so legitimate growth never adds a
      // `## User Prompt` header — only a racing inject does.
      const discarded = buf.slice(snap.size).toString('utf8');
      if (/(^|\n)\s*## User Prompt\b/.test(discarded)) {
        appendAutoResumeLog(`truncateHistoryIfAgentWrote[${label}]: SKIPPED truncate — discarded tail (${buf.length - snap.size} bytes) contains a concurrently-injected "## User Prompt" block; refusing to clobber it.`);
        return;
      }
      const fd = fs.openSync(historyPath, 'r+');
      try { fs.ftruncateSync(fd, snap.size); } finally { fs.closeSync(fd); }
    }
  } finally {
    releaseFileLock(lock);
  }
}

function stripTrailingDivider(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8');
    const trimmed = existing.replace(/\s*---\s*$/, '');
    if (trimmed.length !== existing.length) fs.writeFileSync(filePath, trimmed, 'utf8');
  } catch {}
}

// =========================================================================
// History auto-archive: when line-count threshold exceeded, summarize+rotate.
// =========================================================================
const HISTORY_ARCHIVE_CLEAR_MARKER = '<!-- CLEAR CONTEXT -->';
const DEFAULT_HISTORY_ARCHIVE_THRESHOLD = 4000;

// Compression path removed: plain archive rotation only — no summary section
// is ever injected, and the deprecated history-archive-compress-on-archive
// config key is ignored if present.
async function maybeAutoArchiveHistory(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  const lineCount = content.split('\n').length;
  const threshold = (config && typeof config['history-archive-threshold-lines'] === 'number')
    ? config['history-archive-threshold-lines']
    : DEFAULT_HISTORY_ARCHIVE_THRESHOLD;
  if (lineCount <= threshold) return;

  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = `${base}.archive-${ts}${ext}`;
  try { fs.copyFileSync(filePath, backupPath); } catch (err) {
    log(`[harness] WARNING: history archive backup failed: ${err.message}`);
    return;
  }

  const backupName = path.basename(backupPath);

  // Preserve user-typed (untagged, non-empty) trailing prompt body so a mid-edit
  // prompt is not lost when the file is rolled over. Tagged headers like
  // `(From the Queue)` are dropped so queue dequeue fires normally.
  const _trailingPromptRe = /(\n+(?:---\s*\n+)?)## User Prompt([^\n]*)\n((?:(?!\n## User Prompt)[\s\S])*)$/;
  const _tpm = _trailingPromptRe.exec(content);
  let _preservedPromptSuffix = '';
  if (_tpm) {
    const _headerSuffix = _tpm[2].trim();
    const _bodyRaw = _tpm[3] || '';
    const _bodyStripped = _bodyRaw.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!_headerSuffix && _bodyStripped.length > 0) {
      _preservedPromptSuffix = _bodyRaw;
    }
  }

  const archiveContent = `${HISTORY_ARCHIVE_CLEAR_MARKER}\n\n## Coding Agent Response (History Archived)\n\nHistory file exceeded ${threshold} lines (${lineCount} lines). Full history backed up to \`${backupName}\`. Context resumes here.\n\n## User Prompt\n${_preservedPromptSuffix}`;
  try { fs.writeFileSync(filePath, archiveContent, 'utf8'); } catch (err) {
    log(`[harness] WARNING: history archive write failed: ${err.message}`);
    return;
  }

  log(`[harness] History file exceeded ${threshold} lines — archived to ${backupName}`);
}

// =========================================================================
// History writers: append role section + canonical trailing "## User Prompt"
// placeholder. Idempotent — collapses stacked empty placeholders.
// =========================================================================
function appendToFile(filePath, header, content, { appendUserPromptSuffix = true } = {}) {
  const lock = acquireFileLock(filePath);
  try {
    stripTrailingDivider(filePath);
    const safe = sanitizeForAppend(content);
    // Idempotence guard: if last block with this exact header has identical body, skip.
    // Prevents duplicate `## Coding Agent Response` blocks when a phase re-runs after
    // an aborted append.
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      const re = new RegExp(`(^|\\n)${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'g');
      let m, lastBody = null;
      while ((m = re.exec(existing)) !== null) lastBody = m[2];
      if (lastBody != null) {
        const norm = s => s.replace(/\r\n/g, '\n').replace(/\n\n\*Model:[\s\S]*?\*\s*$/, '').trim();
        if (norm(lastBody) === norm(safe) && norm(safe).length > 0) {
          // Recognise BOTH untagged `## User Prompt` AND tagged
          // `## User Prompt (From the Queue)` trailing placeholders so we don't
          // stack a duplicate on top of an existing one.
          if (appendUserPromptSuffix && !/##\s+User Prompt(?:\s+\([^)]+\))?\s*\n*\s*$/.test(existing)) {
            fs.appendFileSync(filePath, '\n\n---\n\n## User Prompt\n\n', 'utf8');
          }
          return;
        }
      }
    } catch {}
    const suffix = appendUserPromptSuffix ? '\n\n---\n\n## User Prompt\n\n' : '';
    const tail = suffix || '\n';
    fs.appendFileSync(filePath, `\n\n---\n\n${header}\n\n${safe}${tail}`, 'utf8');
  } finally {
    releaseFileLock(lock);
  }
}

function appendUserPromptSuffixToFile(filePath) {
  const lock = acquireFileLock(filePath);
  try {
    stripTrailingDivider(filePath);
    // Refuse to stack another placeholder if the file already ends with a
    // `## User Prompt[...]` header (tagged or untagged) whose body is empty.
    // Prevents duplicate trailing headers that confuse latest-prompt parsing.
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (/##\s+User Prompt(?:\s+\([^)]+\))?\s*\n*\s*$/.test(existing)) return;
    } catch {}
    fs.appendFileSync(filePath, '\n\n---\n\n## User Prompt\n\n', 'utf8');
  }
  finally { releaseFileLock(lock); }
}

// ── Model resolution ──────────────────────────────────────────────────────────

// =========================================================================
// Model selection: configured alias -> concrete id; rate-limit downgrade
// (opus -> sonnet -> haiku) when prior runs hit per-tier ceilings.
// =========================================================================
function resolveModelId(configured) {
  if (!configured || configured.trim() === '') return null;
  const lower = configured.toLowerCase().trim();
  if (lower === 'auto') return 'auto';
  if (/^opus/.test(lower) || (configured.startsWith('claude-') && lower.includes('opus'))) return LATEST_OPUS;
  if (/^sonnet/.test(lower) || (configured.startsWith('claude-') && lower.includes('sonnet'))) return LATEST_SONNET;
  if (/^haiku/.test(lower) || (configured.startsWith('claude-') && lower.includes('haiku'))) return LATEST_HAIKU;
  if (configured.startsWith('claude-')) return configured;
  // Non-Claude model IDs (GPT, Gemini, etc.) — pass through as-is.
  return configured;
}

// Item 5: when scraped rate-limit headers show low remaining %, downgrade
// the auto-classified model so we don't exhaust the window on a single big call.
// Returns { modelId, note } where note describes the downgrade for the usage footer.
function applyRateLimitDowngrade(modelId) {
  if (!_rateLimitSeen) return { modelId, note: null };
  let worstPct = Infinity;
  const buckets = new Set();
  for (const k of Object.keys(_rateLimits)) {
    const m = k.match(/^(.+)-(limit|remaining)$/);
    if (m) buckets.add(m[1]);
  }
  for (const b of buckets) {
    const limit = Number(_rateLimits[`${b}-limit`]);
    const remaining = Number(_rateLimits[`${b}-remaining`]);
    if (Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0) {
      const pct = (remaining / limit) * 100;
      if (pct < worstPct) worstPct = pct;
    }
  }
  if (!Number.isFinite(worstPct)) return { modelId, note: null };
  // Item 5 (per user clarification): budget-aware ladder is opus→sonnet ONLY.
  // Never downgrade to haiku via rate-limit pressure — haiku is reserved for the
  // complexity-classifier path (truly simple tasks). Sonnet stays put under low budget.
  // NOTE: Claude-specific — LATEST_OPUS never matches GPT or Gemini model IDs, so
  // non-claude-code providers always pass through unchanged (no rate-limit protection).
  if (worstPct < 20) {
    if (modelId === LATEST_OPUS) return { modelId: LATEST_SONNET, note: `rate-limit <20% → downgraded opus→sonnet` };
  }
  return { modelId, note: null };
}

// Returns true when modelId clearly belongs to a different provider than effectiveProvider
// (e.g. a `gpt-*` id leaking into a claude-code spawn after a provider switch). Used by
// resolveModel to substitute a safe in-tier default instead of forwarding the stale id.
function isModelIdForeignToProvider(modelId, effectiveProvider) {
  if (!modelId || typeof modelId !== 'string') return false;
  const lower = modelId.toLowerCase();
  if (effectiveProvider === 'claude-code') return /^(gpt-|gemini-|o\d)/.test(lower);
  if (effectiveProvider === 'github-copilot') return /^(claude-|gemini-)/.test(lower);
  if (effectiveProvider === 'gemini' || effectiveProvider === 'gemini-vertex') return /^(claude-|gpt-|o\d)/.test(lower);
  return false;
}

// Async because Step 2 awaits `ensureFreshCache` to consult the live model catalog
// before letting a configured id reach the CLI. Step 3 makes `auto` provider-aware:
// claude-code keeps complexity-tiered selection; other providers pick the strongest
// available tier (heavy → medium → light) so non-claude users always get the best model.
async function resolveModel(configured, promptContent = '') {
  const effectiveProvider = configUtils.cfgRead(topicConfig, config, 'provider', 'claude-code');
  const providerTiers = _loadProviderTiers(effectiveProvider);
  let modelId = resolveModelId(configured);
  // Step 2 — pre-flight availability check. If the configured id isn't in the live
  // catalog for this provider, coerce to `auto` so the auto branch below picks a
  // valid model rather than handing an unknown id to the CLI (which would error).
  // `stale` (cache absent/unfetchable) is treated as "unknown" → do NOT coerce,
  // preserving prior behaviour when offline.
  if (modelId && modelId !== 'auto') {
    try {
      const catalog = require('./lib/model-catalog');
      if (typeof catalog.ensureFreshCache === 'function' && typeof catalog.isModelAvailable === 'function') {
        await catalog.ensureFreshCache(effectiveProvider, { syncTimeoutMs: 2500 });
        const status = catalog.isModelAvailable(effectiveProvider, modelId);
        if (status && status.available === false && status.stale !== true) {
          log(`Warning: configured model "${modelId}" not available for provider "${effectiveProvider}" — falling back to auto.`);
          modelId = 'auto';
        }
      }
    } catch (_) {
      // Catalog unavailable — skip pre-flight, defer to downstream cross-provider guards.
    }
  }
  if (modelId === 'auto') {
    // Step 3 — provider-aware auto: claude-code uses complexity tiering; every
    // other provider gets the strongest tier available (heavy → medium → light).
    let resolved;
    if (effectiveProvider === 'claude-code') {
      resolved = autoClassifyModel(promptContent, effectiveProvider);
    } else {
      resolved = providerTiers.heavy || providerTiers.medium || providerTiers.light;
    }
    const downgrade = applyRateLimitDowngrade(resolved);
    resolved = downgrade.modelId;
    // Guard: never let a stale cross-provider id leak through `auto` (e.g. a `gpt-*`
    // value left in topic-config from a prior github-copilot run reaching a claude-code
    // spawn). Substitute the provider's medium tier and warn so the user sees it.
    if (isModelIdForeignToProvider(resolved, effectiveProvider)) {
      log(`Warning: auto-resolved model "${resolved}" is not valid for provider "${effectiveProvider}" — substituting ${providerTiers.medium}.`);
      resolved = providerTiers.medium;
    }
    const family = modelFamilyName(resolved);
    const note = downgrade.note ? `auto → ${family} (${downgrade.note})` : `auto → ${family}`;
    return { modelArgs: ['--model', resolved], fallbackNote: note };
  }
  if (modelId && isModelIdForeignToProvider(modelId, effectiveProvider)) {
    const sub = providerTiers.medium;
    log(`Warning: configured model "${modelId}" is not valid for provider "${effectiveProvider}" — substituting ${sub}.`);
    return { modelArgs: ['--model', sub], fallbackNote: `cross-provider id "${modelId}" → ${sub}` };
  }
  if (modelId && modelId !== configured) {
    return { modelArgs: ['--model', modelId], fallbackNote: `"${configured}" → ${modelId}` };
  }
  if (modelId) {
    return { modelArgs: ['--model', modelId], fallbackNote: null };
  }
  const mediumModel = providerTiers.medium;
  if (configured && configured.trim() !== '') {
    return { modelArgs: ['--model', mediumModel], fallbackNote: `invalid model "${configured}" → ${mediumModel}` };
  }
  return { modelArgs: ['--model', mediumModel], fallbackNote: null };
}

function modelFamilyName(modelId) {
  if (modelId === LATEST_OPUS) return 'opus';
  if (modelId === LATEST_SONNET) return 'sonnet';
  if (modelId === LATEST_HAIKU) return 'haiku';
  const claudeM = modelId.match(/^claude-([a-z]+)/);
  if (claudeM) return claudeM[1];
  const geminiM = modelId.match(/^gemini-[\d.]+-(\w+)/);
  if (geminiM) return `gemini-${geminiM[1]}`;
  return modelId;
}

// ── Effort resolution ─────────────────────────────────────────────────────────

// =========================================================================
// Effort & auto-classification: prompt-complexity scoring -> effort level
// (low/medium/high/max) + per-provider model tier (light/medium/heavy).
// Planning text can also encode an effort/model override for next phase.
// =========================================================================
const EFFORT_BUDGET_TOKENS = { low: 1024, medium: 5000, high: 12000, max: 32000 };

function computePromptScore(content) {
  const lower = (content || '').toLowerCase();
  let score = 0;

  if (lower.length >= 1500) score += 3;
  else if (lower.length >= 500) score += 2;
  else if (lower.length >= 150) score += 1;

  const reqCount = (lower.match(/^\s*(?:\d+[.)]\s|[-*•]\s)/gm) || []).length;
  if (reqCount >= 5) score += 3;
  else if (reqCount >= 3) score += 2;
  else if (reqCount >= 1) score += 1;

  if (/\b(architecture|overhaul|full rewrite|redesign|comprehensive|migrate all|refactor all|from scratch)\b/.test(lower)) score += 3;
  if (/\b(refactor|parallel|pipeline|implement|integrate|restructure|modular|extract|abstraction)\b/.test(lower)) score += 2;
  if (/\b(rename|typo|fix typo|minor|quick|small|update readme|remove comment)\b/.test(lower)) score -= 2;

  const verbHits = ['add', 'update', 'create', 'remove', 'fix', 'change', 'replace', 'move', 'delete', 'implement', 'refactor']
    .filter(v => new RegExp(`\\b${v}\\b`).test(lower)).length;
  if (verbHits >= 5) score += 2;
  else if (verbHits >= 3) score += 1;

  return score;
}

function autoClassifyEffort(content) {
  const score = computePromptScore(content);
  if (score <= 1) return 'low';
  if (score <= 3) return 'medium';
  if (score <= 6) return 'high';
  return 'max';
}

// Map prompt-complexity score -> provider model tier. Heavy gate raised to >8
// (was >5): verbose-but-routine prompts inflate `computePromptScore` (length +3,
// >=5 bullets +3, generic verbs +2) and were over-assigning the heavy tier (Opus).
// Heavy now requires genuine architectural signals stacked on top of verbosity,
// not verbosity alone — fixing the "almost always Opus" cost complaint.
// Architectural override: a brief-but-hard prompt (e.g. "redesign the auth
// architecture from scratch") carries strong difficulty signal but a low raw
// score, so the >8 gate alone would never reach Opus. Route any genuine
// architecture/rewrite keyword straight to heavy regardless of verbosity, so
// Opus stays RESERVED for hard tasks rather than ELIMINATED for terse ones.
function autoClassifyModel(content, provider) {
  const tiers = _loadProviderTiers(provider);
  const lower = (content || '').toLowerCase();
  const architectural = /\b(architecture|overhaul|full rewrite|redesign|comprehensive|migrate all|refactor all|from scratch)\b/.test(lower);
  if (architectural) return tiers.heavy;
  const score = computePromptScore(content);
  if (score <= 1) return tiers.light;
  if (score <= 8) return tiers.medium;
  return tiers.heavy;
}

function resolveEffort(configured, promptContent = '') {
  if (!configured || configured.trim() === '' || configured.toLowerCase() === 'none') {
    return { effortEnv: {}, effortNote: null };
  }
  const key = configured.toLowerCase().trim();
  if (key === 'auto') {
    const resolved = autoClassifyEffort(promptContent);
    const tokens = EFFORT_BUDGET_TOKENS[resolved];
    return { effortEnv: { MAX_THINKING_TOKENS: String(tokens) }, effortNote: `auto → ${resolved}` };
  }
  const tokens = EFFORT_BUDGET_TOKENS[key];
  if (!tokens) {
    log(`Warning: unknown effort level "${configured}" — ignored.`);
    return { effortEnv: {}, effortNote: `unknown effort "${configured}" — ignored` };
  }
  return { effortEnv: { MAX_THINKING_TOKENS: String(tokens) }, effortNote: key };
}

function resolveRoleEffort(role) {
  if (topicConfig && topicConfig.modelEffort) {
    const level = topicConfig.modelEffort[role];
    if (level != null && level !== '') return level;
  }
  return '';
}

// `promptForModel` (the ORIGINAL user prompt) drives model-tier classification,
// while `planningText` still drives effort. Scoring the verbose plan output for
// the model tier inflated the score (plan length/bullets are planner artifacts,
// not task difficulty) and forced Opus almost always. Falls back to planningText
// when the caller has no original prompt, preserving prior behavior.
function applyPlanningEffortAndModel(planningText, promptForModel) {
  // Guard: empty planningText causes autoClassifyModel to return the lightest tier
  // unconditionally, silently downgrading subsequent phases. Skip apply.
  if (!planningText || !planningText.trim()) return;
  const modelSource = (promptForModel && promptForModel.trim()) ? promptForModel : planningText;
  const resolvedEffort = autoClassifyEffort(planningText);
  const resolvedModel = autoClassifyModel(modelSource, configUtils.cfgRead(topicConfig, config, 'provider', 'claude-code'));
  const family = modelFamilyName(resolvedModel);
  acquireTopicConfigLock(TOPIC_LOCK_PATH);
  try {
    const fresh = configUtils.loadConfig(topicConfigPath);
    fresh['model-effort'] = fresh['model-effort'] || fresh.modelEffort || {};
    if (fresh.modelEffort && fresh.modelEffort !== fresh['model-effort']) delete fresh.modelEffort;
    fresh.models = fresh.models || {};
    // Capture original values before overwrite so restoreAutoModelFields restores exactly
    // (e.g. "max" stays "max", not silently replaced with "auto").
    const origModels = {};
    const origEffort = {};
    for (const role of ['coding', 'assessment']) {
      origModels[role] = fresh.models[role] != null ? fresh.models[role] : null;
      origEffort[role] = fresh['model-effort'][role] != null ? fresh['model-effort'][role] : null;
      fresh.models[role] = resolvedModel;
      fresh['model-effort'][role] = resolvedEffort;
    }
    // Store originals as objects so restore path recovers pre-planning values precisely.
    fresh['_harness_auto_set'] = { models: origModels, 'model-effort': origEffort };
    configUtils.writeConfig(topicConfigPath, fresh);
  } finally {
    releaseTopicConfigLock(TOPIC_LOCK_PATH);
  }
  // Mirror unconditional override in in-memory topicConfig.
  topicConfig.modelEffort = topicConfig.modelEffort || {};
  topicConfig.modelEffort.coding = resolvedEffort;
  topicConfig.modelEffort.assessment = resolvedEffort;
  topicConfig.models = topicConfig.models || {};
  topicConfig.models.coding = resolvedModel;
  topicConfig.models.assessment = resolvedModel;
}

// ── Usage footer ──────────────────────────────────────────────────────────────

function actionVerbositySuffix() {
  const v = topicConfig ? (topicConfig.outputVerbosity ?? 5) : 5;
  if (v <= 2) return ' List only the changed file names, one bullet per file.';
  if (v <= 4) return ' Format the response as a markdown bullet list with one blank line between bullets. Keep it under 5 bullets.';
  if (v >= 8) return ' Format the response as a markdown bullet list with one blank line between bullets. Provide detailed explanations and reasoning per bullet.';
  return ' Format the response as a markdown bullet list with one blank line between bullets.';
}

// Bucket scale for raw token counts (in/out). Cache reads use a 10× scale.
// =========================================================================
// Usage bucketization + rate-limit header scraping. Footer/limits-line
// builders format end-of-run summary lines (tokens, cost, rate-window).
// =========================================================================
function bucketize(n, kind = 'tokens') {
  const scale = kind === 'cache' ? 10 : 1;
  if (n < 1_000 * scale) return 'tiny';
  if (n < 10_000 * scale) return 'small';
  if (n < 100_000 * scale) return 'medium';
  if (n < 1_000_000 * scale) return 'large';
  return 'huge';
}

// Rate-limit headers scraped from `claude` CLI stderr/stdout (ANTHROPIC_LOG=debug surfaces them).
// Keys mirror Anthropic API response headers: anthropic-ratelimit-<bucket>-{limit,remaining,reset}.
const _rateLimits = {};
let _rateLimitSeen = false;
function scrapeRateLimitHeaders(text) {
  if (!text) return;
  // Match formats: `anthropic-ratelimit-foo-limit: 1234`, `"anthropic-ratelimit-foo-limit":"1234"`, header lines, JSON.
  const re = /anthropic-ratelimit-([a-z0-9-]+?-(?:limit|remaining|reset))['"]?\s*[:=]\s*['"]?([^'",\s}\r\n]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2];
    _rateLimits[key] = val;
    _rateLimitSeen = true;
  }
}

let _ccusageSkipped = false;
function _runCcusage(args) {
  if (_ccusageSkipped) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; resolve(val); };
    try {
      const child = spawn('npx', ['--yes', 'ccusage@latest', ...args], {
        cwd: ROOT, shell: process.platform === 'win32', windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.on('error', () => { _ccusageSkipped = true; log('ccusage unavailable — disabling for this run.'); finish(null); });
      const timer = setTimeout(() => { try { child.kill(); } catch {} _ccusageSkipped = true; finish(null); }, 4000);
      child.on('close', () => {
        clearTimeout(timer);
        try { finish(JSON.parse(out)); } catch { finish(null); }
      });
    } catch { _ccusageSkipped = true; finish(null); }
  });
}

// Build limits segment from scraped anthropic-ratelimit-* headers (preferred path — true % from API).
// Returns "" if no headers were captured this run. Anthropic emits multiple buckets
// (input-tokens, output-tokens, tokens, requests); we surface each with limit/remaining/reset.
function buildLimitsLineFromHeaders() {
  if (!_rateLimitSeen) return '';
  const buckets = new Set();
  for (const k of Object.keys(_rateLimits)) {
    const m = k.match(/^(.+)-(limit|remaining|reset)$/);
    if (m) buckets.add(m[1]);
  }
  if (!buckets.size) return '';
  const segments = [];
  for (const b of buckets) {
    const limit = Number(_rateLimits[`${b}-limit`]);
    const remaining = Number(_rateLimits[`${b}-remaining`]);
    const reset = _rateLimits[`${b}-reset`];
    if (Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0) {
      const used = limit - remaining;
      const pct = ((used / limit) * 100).toFixed(1);
      const resetStr = reset ? ` resets ${reset}` : '';
      segments.push(`${b}: ${pct}% (${used.toLocaleString()}/${limit.toLocaleString()}${resetStr})`);
    }
  }
  if (!segments.length) return '';
  return `\n\n*Usage limits — ${segments.join(' | ')} (anthropic-ratelimit headers)*`;
}

// End-of-run limits line: prefer Anthropic rate-limit headers (true % from API);
// fall back to ccusage local counts (no true cap, just session/weekly token totals).
// Called once when the pipeline exits — not per-phase.
async function buildEndOfRunLimitsLine() {
  if (!configUtils.cfgRead(topicConfig, config, 'show-usage-stats', true)) return '';
  if (!configUtils.cfgRead(topicConfig, config, 'show-limit-line', true)) return '';

  const headerLine = buildLimitsLineFromHeaders();
  if (headerLine) return headerLine;

  const limit5h = Number(configUtils.cfgRead(topicConfig, config, 'token-5h-limit', 0)) || 0;
  const limitWeek = Number(configUtils.cfgRead(topicConfig, config, 'token-weekly-limit', 0)) || 0;

  const blocksJson = await _runCcusage(['blocks', '--json', '--active']);
  if (!blocksJson) return '';
  const blocks = Array.isArray(blocksJson) ? blocksJson : (blocksJson.blocks || []);
  const active = blocks.find(b => b.isActive) || blocks[blocks.length - 1] || {};
  const blockIn = (active.inputTokens ?? active.input_tokens ?? 0);
  const blockOut = (active.outputTokens ?? active.output_tokens ?? 0);
  const blockTotal = blockIn + blockOut;

  const dailyJson = await _runCcusage(['daily', '--json']);
  let weekTotal = 0;
  if (dailyJson) {
    const days = Array.isArray(dailyJson) ? dailyJson : (dailyJson.daily || dailyJson.days || []);
    const last7 = days.slice(-7);
    for (const d of last7) {
      weekTotal += (d.inputTokens ?? d.input_tokens ?? 0) + (d.outputTokens ?? d.output_tokens ?? 0);
    }
  }

  const fmt = (used, cap) => cap > 0
    ? `${((used / cap) * 100).toFixed(1)}% (${used.toLocaleString()}/${cap.toLocaleString()})`
    : `${used.toLocaleString()} tokens`;
  const segments = [`5h: ${fmt(blockTotal, limit5h)}`];
  if (weekTotal > 0 || limitWeek > 0) segments.push(`weekly: ${fmt(weekTotal, limitWeek)}`);
  return `\n\n*Usage limits — ${segments.join(' | ')} (ccusage, local totals — no true cap)*`;
}

async function buildUsageFooter(model, usage, costUsd, fallbackNote, effortNote, extras = {}) {
  const parts = [];
  if (model) {
    const modelDisplay = fallbackNote ? `${model} (${fallbackNote})` : model;
    parts.push(`Model: ${modelDisplay}`);
  }
  if (effortNote) parts.push(`Effort: ${effortNote}`);
  if (usage) {
    const inRaw = usage.input_tokens || 0;
    const outRaw = usage.output_tokens || 0;
    const bucket = bucketize(outRaw, 'tokens');
    parts.push(`Tokens: ${inRaw.toLocaleString()} in / ${outRaw.toLocaleString()} out (${bucket})`);
    if (usage.cache_read_input_tokens) {
      const cr = usage.cache_read_input_tokens;
      parts.push(`Cache read: ${cr.toLocaleString()} (${bucketize(cr, 'cache')})`);
    }
  }
  if (costUsd != null) parts.push(`Cost: $${costUsd.toFixed(6)} USD`);
  if (extras && extras.stopReason && extras.stopReason !== 'end_turn') {
    parts.push(`stop_reason=${extras.stopReason}`);
  }
  if (extras && extras.continuations) parts.push(`continuations=${extras.continuations}`);
  return parts.length > 0 ? `\n\n*${parts.join(' | ')}*` : '';
}

// ── Context helpers ───────────────────────────────────────────────────────────

// =========================================================================
// Context section: build the per-run "files to read first" preamble
// injected into the agent's system context. Tracks touched dirs/files,
// validates JSON edits, refreshes topic-context.json.
// =========================================================================
// baseRoot is the topic's root-repo: context-files relative paths resolve against it and
// the agent's spawn cwd matches it, so emitted paths stay relative (and correct) when the
// agent runs inside root-repo instead of the harness ROOT.
function buildContextSection(contextEntries, activeHistoryRel = null, agentCwd = null, baseRoot = ROOT) {
  if (!contextEntries || contextEntries.length === 0) return '';
  const paths = contextEntries.map(e => (typeof e === 'string' ? e : e.path));
  // Structurally exclude the active history file — it's already embedded in the User
  // Prompt; leaving it listed lets the agent enumerate the topic dir and read the full
  // thread, biasing its response toward the conversation rather than the queued prompt.
  const filtered = activeHistoryRel ? paths.filter(p => p !== activeHistoryRel) : paths;
  // Compare the agent cwd against the resolution base (root-repo), not the hardcoded ROOT,
  // so relative paths are kept whenever the agent runs in the same dir we resolve against.
  const useAbsolute = agentCwd && path.resolve(agentCwd) !== path.resolve(baseRoot);

  const lines = [];
  for (const p of filtered) {
    const absEntry = path.join(baseRoot, p);
    if (!fs.existsSync(absEntry)) continue;
    let stat;
    try { stat = fs.statSync(absEntry); } catch { continue; }
    if (stat.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(absEntry); } catch { entries = []; }
      const files = entries.map(name => {
        const fp = path.join(absEntry, name);
        try { const s = fs.statSync(fp); return s.isFile() ? { name, mtime: s.mtimeMs } : null; }
        catch { return null; }
      }).filter(Boolean);
      files.sort((a, b) => b.mtime - a.mtime);
      const capped = files.length > 20;
      for (const f of files.slice(0, 20)) {
        const rel = (p.replace(/\\/g, '/').replace(/\/$/, '') + '/' + f.name);
        lines.push(useAbsolute ? path.join(baseRoot, rel).replace(/\\/g, '/') : rel);
      }
      if (capped) {
        lines.push((useAbsolute ? absEntry.replace(/\\/g, '/') : p) + ' (directory)');
      }
    } else {
      lines.push(useAbsolute ? absEntry.replace(/\\/g, '/') : p);
    }
  }

  if (lines.length === 0) return '';
  // Belt-and-suspenders instructional note in addition to structural exclusion above.
  const historyNote = activeHistoryRel
    ? `\nNote: Do NOT open or read \`${activeHistoryRel}\` — its relevant content is already embedded in the User Prompt above.`
    : '';
  const harnessHint = `Harness location: \`${path.resolve(HARNESS).replace(/\\/g, '/')}\``;
  // Strengthened wording: name the root-repo working dir explicitly and instruct the agent
  // to check root-repo + the listed context-files FIRST, never scanning the whole repo before
  // those locations — this is what stops agents wasting effort enumerating the entire tree.
  const rootHint = `Work inside the root-repo: \`${path.resolve(baseRoot).replace(/\\/g, '/')}\`. This is the ONLY directory you operate in.`;
  return `## Topic Context (prioritize reading and editing these files)\nCRITICAL: ${rootHint}\nCRITICAL: Always read and check the root-repo and the context files listed below FIRST before searching the codebase. Do NOT scan or enumerate the whole repo, and do NOT search for files to modify, until you have first checked these context locations.\n${harnessHint}\n${lines.map(l => `- ${l}`).join('\n')}${historyNote}`;
}

function recordTouchedFiles() {
  // touchedDirs are resolved against ROOT (see path.join(ROOT, candidate) below), so this
  // git status MUST run with cwd: ROOT. Using repoRoot when root-repo != ROOT would yield
  // paths relative to a foreign repo that never exist under ROOT, recording nothing.
  const result = spawnSync('git', ['status', '--short', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return;
  // Strip UTF-8 BOM (git on Windows may emit one at the start of stdout).
  // Split without trimming the whole string: leading space on the first line is
  // the X status code (e.g. ' M' = unmodified index, modified worktree) and must
  // not be stripped by trim() or slice(3) will point at the wrong column.
  const stdout = result.stdout.replace(/^\uFEFF/, '');
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^(..)\s(.+)$/);
    if (!m) continue;
    const xy = m[1];
    let filePath = m[2].trim().replace(/\\/g, '/');
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    if ((xy.includes('R') || xy.includes('C')) && filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop().trim();
      if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    }
    const dir = path.posix.dirname(filePath);
    const candidate = dir && dir !== '.' ? dir : filePath;
    if (!fs.existsSync(path.join(ROOT, candidate))) continue;
    touchedDirs.add(candidate);
  }
}

/**
 * After each coding phase, validate every `.json` file that git shows as
 * modified/added. Returns a list of invalid paths (empty = all OK).
 * Logs each failure so the user/assessment agent can act on it.
 */
function validateTouchedJsonFiles() {
  // JSON validation targets harness JSON under ROOT/HARNESS, and abs paths below join
  // against ROOT — so git MUST run with cwd: ROOT. Using repoRoot here would mismatch the
  // `harnessRel` pathspec when root-repo != ROOT, silently matching nothing and letting
  // malformed harness JSON pass unchecked.
  const harnessRel = path.relative(ROOT, HARNESS);
  const result = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACM', '--', harnessRel], { cwd: ROOT, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', harnessRel], { cwd: ROOT, encoding: 'utf8' });
  const changedLines = [
    ...(result.stdout || '').trim().split('\n'),
    ...(untracked.stdout || '').trim().split('\n'),
  ].map(l => l.trim()).filter(l => l.endsWith('.json'));

  const invalid = [];
  for (const rel of changedLines) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      invalid.push({ path: rel, error: e.message });
      log(`[post-edit-validation] INVALID JSON: ${rel} — ${e.message}`);
    }
  }
  return invalid;
}

function validateTouchedJsonFilesOrThrow() {
  const invalid = validateTouchedJsonFiles();
  if (invalid.length) {
    const summary = invalid.map(f => `  ${f.path}: ${f.error}`).join('\n');
    throw new Error(`[post-edit-validation] ${invalid.length} invalid JSON file(s) — aborting phase:\n${summary}`);
  }
}

function updateTopicContext() {
  if (!(topicConfig.autoContext ?? true)) return;
  const maxLifespan = topicConfig.maxContextLifespan;

  const sourceEntries = topicConfig['context-files'] ?? topicConfig.contextFiles ?? topicConfig.context ?? [];

  const normalized = sourceEntries.map(e =>
    typeof e === 'string' ? { path: e, age: 0 } : e
  );
  const existing = [];
  for (const e of normalized) {
    if (fs.existsSync(path.join(ROOT, e.path))) {
      existing.push(e);
    } else {
      console.warn(`[context-hygiene] dropping non-existent context-files entry: "${e.path}"`);
    }
  }

  const updated = [];
  for (const entry of existing) {
    const newAge = touchedDirs.has(entry.path) ? 0 : (entry.age || 0) + 1;
    if (maxLifespan && newAge >= maxLifespan) continue;
    updated.push({ path: entry.path, age: newAge });
  }

  const existingPaths = new Set(updated.map(e => e.path));
  for (const dir of touchedDirs) {
    if (!existingPaths.has(dir) && fs.existsSync(path.join(ROOT, dir))) updated.push({ path: dir, age: 0 });
  }

  topicConfig['context-files'] = updated;
  delete topicConfig.context;
  acquireTopicConfigLock(TOPIC_LOCK_PATH);
  try {
    const fresh = configUtils.loadConfig(topicConfigPath);
    fresh['context-files'] = updated;
    delete fresh.contextFiles;
    delete fresh.context;
    configUtils.writeConfig(topicConfigPath, fresh);
  } finally {
    releaseTopicConfigLock(TOPIC_LOCK_PATH);
  }
  if (touchedDirs.size > 0) log(`Context updated: ${[...touchedDirs].join(', ')}`);
}

// ── Session-continuity preamble (Gap #8) ─────────────────────────────────────

// For stateless providers (capabilities.autoResume=false), reconstruct the most
// recent prior-run agent responses so the model has cross-run context.
// Returns a formatted preamble string, or '' when nothing useful is found.
// =========================================================================
// Provider invocation layer: build payload, resolve role-specific model,
// spawn provider CLI (claude-code / gemini / copilot / vertex), clean up.
// =========================================================================
// Locate the newest sibling archive file produced by `maybeAutoArchiveHistory`.
// Sorted by the embedded ISO timestamp in the filename (NOT mtime) so file
// touches / copies do not reorder results. Returns null when no archives exist.
function findLatestArchive(filePath) {
  try {
    const ext = path.extname(filePath);
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, ext);
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const archiveRe = new RegExp(`^${escaped}\\.archive-(.+)${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const entries = fs.readdirSync(dir)
      .map(name => {
        const m = archiveRe.exec(name);
        return m ? { name, ts: m[1] } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.ts.localeCompare(a.ts));
    return entries.length ? path.join(dir, entries[0].name) : null;
  } catch { return null; }
}

// Shared response extractor used by both the active-history and archive-fallback
// paths in `buildHistoryPreamble`. Keeps slice / truncate semantics identical
// across both paths so the archive fallback never diverges from the live path.
function extractRecentResponses(content, max = 3) {
  const lastPromptIdx = content.lastIndexOf('\n## User Prompt');
  const priorContent = lastPromptIdx > 0 ? content.slice(0, lastPromptIdx) : content;
  // Body capture uses `+?` (not `*?`) so the lazy-with-multiline-`$` lookahead
  // does not match a zero-length body immediately after the header's blank line.
  const respRe = new RegExp(
    `^(##\\s+(?:${ANY_RESPONSE_HEADER})[^\\n]*)\\n([\\s\\S]+?)(?=^##\\s+(?:${ANY_RESPONSE_HEADER})[^\\n]*$|$(?![\\s\\S]))`,
    'gim'
  );
  const responses = [];
  let m;
  while ((m = respRe.exec(priorContent)) !== null) {
    const header = m[1].trim();
    let body = m[2].replace(/\n\n\*Model:[\s\S]*?\*\s*$/, '').trim();
    if (body.length > 800) body = body.slice(0, 800) + '\n...[truncated]';
    if (body) responses.push(`${header}\n\n${body}`);
  }
  return responses.slice(-max);
}

// Reconstructs prior-run agent responses for stateless providers. Falls back to
// the most recent archive file when the active history is post-rotation stub
// (clear-context marker + empty `## User Prompt`) — without this, agents
// immediately after auto-archive report "could not read prior history".
function buildHistoryPreamble() {
  try {
    const content = fs.readFileSync(historyPath, 'utf8');
    let recent = extractRecentResponses(content);
    let archiveNote = '';
    if (!recent.length && content.includes('<!-- CLEAR CONTEXT -->')) {
      const archivePath = findLatestArchive(historyPath);
      if (archivePath) {
        try {
          const archiveContent = fs.readFileSync(archivePath, 'utf8');
          recent = extractRecentResponses(archiveContent);
          if (recent.length) archiveNote = ` (from archive ${path.basename(archivePath)})`;
        } catch {}
      }
    }
    if (!recent.length) return '';
    return `## Prior Session Context (reconstructed for stateless provider)${archiveNote}\n\n${recent.join('\n\n---\n\n')}`;
  } catch { return ''; }
}

// Skill wiring intentionally removed pending review per planning gate
// ("draft SKILL.md and stop for review before wiring into run-agent.js").
// `Agent_Orchestrator/skills/history-self-lookup/SKILL.md` remains on disk
// for review; do NOT re-introduce a call site until reviewed and approved.

// ── Claude runner (streaming, stream-json) ────────────────────────────────────

function resolveRoleModel(role) {
  if (topicConfig && topicConfig.models && topicConfig.models[role] != null) {
    return topicConfig.models[role];
  }
  return (topicConfig && topicConfig.model) || '';
}

// Remove the per-call session JSONL that the Claude Code CLI writes into
// `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl`. The Claude Code CLI
// (and any editor extension that wraps it — VS Code, Cursor, etc.) reads
// that directory to populate its chat-history recents; without this cleanup
// every harness child spawn pollutes the user's interactive chat history.
// `CLAUDE_SESSION_DIR` / `ANTHROPIC_PROJECT_DIR` env overrides are not
// honoured by the CLI for the projects-dir transcript, so we delete the
// file post-run instead. Path is editor-agnostic — applies to pure-CLI
// users equally.
function cleanupHarnessSessionFile(sessionId) {
  if (!sessionId) return;
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return;
    for (const entry of fs.readdirSync(projectsDir)) {
      const f = path.join(projectsDir, entry, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  } catch {}
}

async function runClaude(payload, { silent = false, label = 'harness-run-agent.js', role = null } = {}) {
  const verbosity = topicConfig ? (topicConfig.outputVerbosity ?? 5) : 5;
  const streamOutput = !silent && verbosity > 0 && (config.streamOutput !== false);
  const heartbeatMs = config.streamingHeartbeatMs || 5000;
  const prespawnHeartbeatMs = config.prespawnHeartbeatMs || 5000;
  const cliWatchdogMs = config.cliWatchdogMs || 5000;
  // resolveModel is now async (awaits live catalog pre-flight in Step 2); await here
  // so a missing model is coerced to `auto` before spawn instead of failing at the CLI.
  const { modelArgs, fallbackNote } = await resolveModel(role ? resolveRoleModel(role) : (topicConfig && topicConfig.model) || '', payload);
  const { effortEnv, effortNote } = resolveEffort(role ? resolveRoleEffort(role) : '', payload);
  const retryCfg = configUtils.cfgRead(topicConfig, config, 'network-retry', {}) || {};
  const maxAttempts = Number(retryCfg.maxAttempts != null ? retryCfg.maxAttempts : 5) || 5;
  const backoffMs = Array.isArray(retryCfg.backoffMs) && retryCfg.backoffMs.length
    ? retryCfg.backoffMs.map(n => Number(n) || 0)
    : [1000, 4000, 10000, 30000, 60000];
  // Use topic-config provider (same source as resolveModel) so getProvider() and
  // resolveModel() agree when provider is set only in topic-config, not global-config.
  const effectiveProviderId = configUtils.cfgRead(topicConfig, config, 'provider', null);
  const provider = getProvider(effectiveProviderId);
  // Gap #8: stateless providers have no session memory — prepend prior-run agent responses.
  let finalPayload = payload;
  if (provider.capabilities && !provider.capabilities.autoResume) {
    const preamble = buildHistoryPreamble();
    if (preamble) finalPayload = preamble + '\n\n' + payload;
  }
  const stopReasonFallback = !!configUtils.cfgRead(topicConfig, config, 'enableStopReasonFallback', false);
  // Spawn the provider CLI inside the topic's root-repo so the agent's own filesystem
  // view and tool calls are rooted there, matching the git/context resolution base.
  const spawnOpts = { silent, label, modelArgs, effortEnv, fallbackNote, effortNote, streamOutput, heartbeatMs, prespawnHeartbeatMs, cliWatchdogMs, maxAttempts, backoffMs, stopReasonFallback, cwd: repoRoot };
  try {
    return await provider.spawn(finalPayload, spawnOpts);
  } catch (err) {
    // ClaudeCodeProvider handles model-unavailable fallback internally via tryModelFallback.
    // For _adaptModule-based providers (github-copilot, gemini) retry once with the
    // provider's medium tier so a stale/invalid model id does not permanently block runs.
    if (err && err.modelUnavailable && provider.id !== 'claude-code') {
      const tiers = _loadProviderTiers(provider.id);
      const fallbackModel = tiers && tiers.medium;
      const attempted = err.attemptedModel || (modelArgs && modelArgs[1]) || 'unknown';
      if (fallbackModel && fallbackModel !== attempted) {
        const note = `model "${attempted}" unavailable → fell back to ${fallbackModel}`;
        log(`[${label}] ${note}`);
        return provider.spawn(finalPayload, { ...spawnOpts, modelArgs: ['--model', fallbackModel], fallbackNote: note });
      }
      err.message = `Selected model "${attempted}" is unavailable for provider "${provider.id}". Edit topic-config.json \`models.<role>\` to pick a supported id.`;
    }
    throw err;
  }
}

function buildPayload(globalRules, systemPrompt, action, userPrompt, contextSection = '') {
  return [globalRules, systemPrompt, contextSection, `Action: ${action}`, userPrompt].filter(Boolean).join('\n');
}

// ── Git stage + commit ────────────────────────────────────────────────────────

// =========================================================================
// Git staging + auto-commit of agent edits; flush unsaved IDE buffers
// (VS Code / Cursor) before any read of working-tree files.
// =========================================================================
async function stageAndCommitChanges() {
  if (!topicConfig.stageAndCommit) return;

  const stageResult = spawnSync('git', ['add', '-A'], { cwd: repoRoot, encoding: 'utf8' });
  if (stageResult.status !== 0) {
    log(`Warning: git add failed: ${stageResult.stderr.trim()}`);
    return;
  }

  const diffStat = spawnSync('git', ['diff', '--cached', '--stat'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  if (!diffStat) return;

  // Exclude markdown files from the diff used for commit message generation so
  // agent conversation history doesn't leak into the commit message.
  const diffFull = spawnSync('git', ['diff', '--cached', '--', ':!*.md'], { cwd: repoRoot, encoding: 'utf8' }).stdout
    || spawnSync('git', ['diff', '--cached'], { cwd: repoRoot, encoding: 'utf8' }).stdout;

  const commitPayload = `Write a single-line git commit message (imperative mood, under 72 chars) for these staged changes. Output only the message, no quotes, no explanation.\n\n${diffFull.slice(0, 4000)}`;
  const { text: rawCommit } = await runClaude(commitPayload, { silent: true });
  const commitMsg = rawCommit.trim().replace(/^["']|["']$/g, '');

  const commitResult = spawnSync('git', ['commit', '-m', commitMsg], { cwd: repoRoot, encoding: 'utf8' });
  if (commitResult.status !== 0) {
    log(`Warning: git commit failed: ${commitResult.stderr.trim()}`);
  } else {
    log(`Committed: ${commitMsg}`);
  }
}

async function saveUserChanges() {
  if (!topicConfig.stageAndCommit) return;
  const diffResult = spawnSync('git', ['diff', '--stat'], { cwd: repoRoot, encoding: 'utf8' });
  if (!diffResult.stdout.trim()) return;

  spawnSync('git', ['add', '-u'], { cwd: repoRoot, encoding: 'utf8' });
  const cachedStat = spawnSync('git', ['diff', '--cached', '--stat'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  if (!cachedStat) return;

  const firstLine = cachedStat.split('\n')[0].trim();
  const commitMsg = `Save user changes: ${firstLine}`;
  const commitResult = spawnSync('git', ['commit', '-m', commitMsg], { cwd: repoRoot, encoding: 'utf8' });
  if (commitResult.status === 0) log(`Saved: ${commitMsg}`);
  else log(`Warning: could not save user changes: ${commitResult.stderr.trim()}`);
}

let _vsCodeSaveFailureLogged = false;
// Editor-agnostic buffer flush. Delegates to the hardcoded keystroke flush in
// editor-buffer-flush.js (no config knobs) — focuses the running IDE window and
// sends its Save-All chord (auto-detected from keybindings.json, ^(k)s fallback).
// Per-run throttle. Synthesizing the Save-All chord focuses the editor window and
// can flash the taskbar icon. The harness used to flush on
// every `snapshotHistorySize` -> taskbar flashed once per phase boundary. Now:
// first call per harness run actually flushes; subsequent default-mode (non-
// force) calls no-op. User-interaction boundaries (CLI command entry,
// clarifying-questions pause, after-CLI-reply) pass `{force: true}` so any
// edits the user typed during the interactive window still get captured.
let _editorFlushedThisRun = false;
function _resetEditorFlushThrottle() { _editorFlushedThisRun = false; }
function flushEditorBuffers(opts) {
  const force = !!(opts && opts.force);
  if (!force && _editorFlushedThisRun) return;
  // Cross-process double-fire guard. An ancestor entry-point (editor-buffer-
  // flush.js) may have already flushed and set HARNESS_EDITOR_FLUSHED=1 before
  // spawning this child; without this, the child's non-force dispatch-entry
  // flush re-fires the keystroke chord -> two focus-steals + two Ctrl+K S per
  // hrun. Forced calls (drain / interactive boundaries) deliberately bypass the
  // guard — the user may have typed a new prompt since the entry-point flush.
  if (!force && process.env[FLUSHED_ENV] === '1') return;
  _editorFlushedThisRun = true;
  try {
    // Keystroke flush is the sole, non-configurable mechanism. All tunables
    // (flush delay, window-match, Save-All chord) are hardcoded in
    // editor-buffer-flush.js; the chord is auto-detected from the running IDE's
    // keybindings.json with a ^(k)s fallback. Mark flushed after the keystroke
    // flush so spawned children skip their redundant non-force dispatch-entry flush.
    flushViaKeystroke();
    process.env[FLUSHED_ENV] = '1';
  } catch (e) {
    if (!_vsCodeSaveFailureLogged) {
      _vsCodeSaveFailureLogged = true;
      console.error(`editor buffer flush failed: ${e.message} — continuing silently.`);
    }
  }
}
// Back-compat alias -> existing call sites + tests reference old name; one source of truth.
const saveAllVsCodeBuffers = flushEditorBuffers;

// ── Regression-test skill clause (pure, testable) ─────────────────────────────
// Extracted as a pure function (config injected, not closed-over) and defined
// BEFORE the require-surface early-return so it is callable from tests without
// running the imperative CLI bootstrap. Gated on `use-regression-skill` (topic
// over global, kebab/camel via cfgRead) and INDEPENDENT of the legacy
// `regression-tests` flag. Loads the regression-test SKILL.md, strips its
// frontmatter, and returns a role-tailored heading so coding agents WRITE
// behavioural tests and assessment agents REVIEW them for the diagnosed
// anti-patterns. Missing file -> warn + '' (never throws).
// `opts` is an optional injection seam (skillPath / fs / log) so the missing-file
// warn-not-throw branch is behaviourally unit-testable without disturbing the real
// SKILL.md on disk; production callers omit it and get the default ROOT path + fs.
function resolveRegressionSkillClauseFor(topicConfigArg, configArg, role, opts = {}) {
  const _fs = opts.fs || fs;
  const _log = opts.log || (typeof log === 'function' ? log : null);
  const enabled = configUtils.cfgRead(topicConfigArg, configArg, 'use-regression-skill', false);
  if (!(enabled === true || enabled === 'true')) return '';
  const skillPath = opts.skillPath || path.join(ROOT, 'Agent_Orchestrator/skills/regression-test/SKILL.md');
  if (!_fs.existsSync(skillPath)) {
    try { if (_log) _log(`Warning: use-regression-skill is enabled but skill file not found at ${skillPath} — ignoring.`); } catch {}
    return '';
  }
  const body = _fs.readFileSync(skillPath, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  if (role === 'assessment') {
    const assessmentPreamble = `When the coding agent added or changed tests, hold them to this discipline. Reject any new test that asserts against source text, isolates code in a \`new Function\` factory, peeks at private fields, or covers a single shape where the code branches on a matrix.\n\n`;
    return `\n\n## Regression-Test Discipline (assessment — mandatory)\n${assessmentPreamble}${body}`;
  }
  return `\n\n## Regression-Test Discipline (mandatory)\n${body}`;
}

// Prefix a fleet subtask error with its [task-N] label WITHOUT discarding the
// original error object. Why: parallel fleets previously rewrapped failures in
// `new Error(...)`, which dropped typed token props (tokenReset/tokensExhausted/
// monthlyCapHit/cliOutput). Mutating .message in place preserves those props so
// the runPipeline catch block can still fire the inline countdown / provider
// fallback. Pure + hoisted so the regression test can require it directly.
function _prefixFleetError(err, label) {
  err.message = `[${label}] ${err.message}`;
  return err;
}

// ── Load config ───────────────────────────────────────────────────────────────

// Test-introspection surface: when this file is `require()`d (not invoked as
// CLI entry point), expose the pure helpers `buildSystemPrompt`,
// `resolveModel`, `resolveModelId` and short-circuit BEFORE the top-level
// imperative arg-parsing / dispatch IIFE runs. Both helpers are
// function-declarations defined later in this file, so JS hoisting makes them
// safe to reference here. Added for provider-matrix.test.js parameterised
// matrix without altering CLI semantics.
// `_playSoundFile` additionally exported so the per-event-sound regression test
// can assert each declared `*-sound-file` default resolves to a `.wav` path
// (guards against config/source drift).
if (require.main !== module) {
  module.exports = { buildSystemPrompt, resolveModel, resolveModelId, resolveRegressionSkillClauseFor, _prefixFleetError, _playSoundFile };
  return;
}

if (process.argv[2] === '--probe') {
  // Probe must resolve synchronously before die() calls below execute.
  const cfgPath = configUtils.globalConfigPath();
  const cfg = fs.existsSync(cfgPath) ? configUtils.loadConfig(cfgPath) : {};
  const providerId = cfg.provider || 'claude-code';
  let provider;
  try { provider = getProvider(providerId); }
  catch (e) { log(`[probe] Cannot resolve provider "${providerId}": ${e.message}`); process.exit(1); }
  provider.probe().then(ok => {
    if (ok) {
      log(`[probe] Provider "${providerId}" is available.`);
      process.exit(0);
    } else {
      log(`[probe] Provider "${providerId}" is NOT available.`);
      try { log(provider.loginInstructions()); } catch {}
      process.exit(1);
    }
  }).catch(err => {
    log(`[probe] Provider "${providerId}" probe failed: ${err.message}`);
    try { log(provider.loginInstructions()); } catch {}
    process.exit(1);
  });
}

let [,, topicArg, roleArg] = process.argv;
// `--dump-prompt`: dev-only diagnostic. Prints each role's fully-assembled system
// prompt (base + all conditional clauses) to stdout, then exits. Detected here so
// the flag — which lands in argv[3]/`roleArg` when invoked as `<topic> --dump-prompt`
// — is stripped before role validation (line ~1875) would reject it as an invalid
// role. Topic still resolves normally so the dump reflects the live topic config.
// USAGE: `node run-agent.js <topic> --dump-prompt`. The topic MUST be argv[2];
// there is no topicless form — the dump always reflects a resolved topic's config.
const dumpPrompt = process.argv.includes('--dump-prompt');
if (dumpPrompt && roleArg === '--dump-prompt') roleArg = undefined;
// =========================================================================
// CLI bootstrap: resolve topic from argv/.last-topic, load global+topic
// configs under lock, register topic in active-topics, set history path.
// =========================================================================
// `.last-topic` path is overridable via env so e2e tests (which spawn this
// binary in a child process) can redirect the pointer write to a temp file
// instead of clobbering the user's real `.last-topic`. Same for the topics
// dir used by the guard's fallback lookup — `AGENT_ORCH_TOPICS_DIR` lets a
// test point both reads (existence checks) and recovery rewrites at an
// isolated tree without touching the real harness state.
const lastTopicPath = process.env.AGENT_ORCH_LAST_TOPIC_PATH
  ? path.resolve(process.env.AGENT_ORCH_LAST_TOPIC_PATH)
  : path.join(HARNESS, '.last-topic');

if (topicArg && VALID_ROLES.includes(topicArg) && !roleArg) {
  roleArg = topicArg;
  topicArg = '';
}

if (!topicArg) {
  // `.last-topic` recovery: cover the missing / empty / whitespace-only / stale
  // states triggered by an interrupted previous write or a deleted topic dir.
  // Why: a 0-byte `.last-topic` (observed after a crash mid-write) previously
  // slipped through and dispatched with no topic. Now: list available topics
  // from the config's topic-ids map and surface a single, actionable message.
  const _listKnownTopics = () => {
    try {
      const cfg = configUtils.loadConfig(configUtils.globalConfigPath());
      const ids = (cfg && (cfg['topic-ids'] || cfg.topicIds)) || {};
      return [...new Set(Object.values(ids))];
    } catch { return []; }
  };
  const _avail = () => {
    const t = _listKnownTopics();
    return t.length ? ` Available: ${t.join(', ')}.` : '';
  };
  // Delegate `.last-topic` resolution to the guard: validates the pointer
  // against on-disk topic dirs and rewrites it atomically when stale/empty
  // /missing. Prevents the harness from dispatching into a non-existent
  // topic (e.g. an e2e stub dir that was cleaned up after a test run).
  const { resolveLastTopic } = require('./lib/last-topic-guard');
  let _topicsDirForGuard;
  let _fallbackForGuard = 'claude_harness';
  // Honor an explicit test-isolation override before consulting config so
  // e2e tests can pin the guard to a temp tree without depending on the
  // canonical config path. Resolved absolutely so child-process cwd drift
  // does not matter.
  if (process.env.AGENT_ORCH_TOPICS_DIR) {
    _topicsDirForGuard = path.resolve(process.env.AGENT_ORCH_TOPICS_DIR);
  } else {
    try {
      const _cfg = configUtils.loadConfig(configUtils.globalConfigPath());
      _topicsDirForGuard = path.join(ROOT, configUtils.resolveTopicFilesDir(_cfg));
      _fallbackForGuard = (_cfg && (_cfg['default-topic'] || _cfg.defaultTopic)) || _fallbackForGuard;
    } catch {
      // HARNESS already resolves to `.../Agent_Orchestrator`, so joining
      // against it (not ROOT) avoids any risk of a dual `Agent_Orchestrator/
      // Agent_Orchestrator/topic_files` prefix if ROOT is ever reconfigured
      // to already include the harness segment.
      _topicsDirForGuard = path.join(HARNESS, 'topic_files');
    }
  }
  const _resolved = resolveLastTopic({
    topicsDir: _topicsDirForGuard,
    lastTopicPath,
    fallback: _fallbackForGuard,
  });
  if (!_resolved.topic) {
    die(`No active topic — ${_resolved.reason || 'unresolvable'}.${_avail()}`);
  }
  if (_resolved.recovered) {
    log(`Warning: .last-topic was ${_resolved.reason}; recovered to "${_resolved.topic}" and rewrote pointer.`);
  }
  topicArg = _resolved.topic;
  log(`Using last topic: "${topicArg}"`);
}

// `roleArg` may be absent when invoked topic-only (`hrun 3`, `hrun <topic>`, or
// bare `hrun`). Defer pipeline resolution to dispatch, where the prompt-file
// header and promptQueue.defaultPipeline become available. `roleExplicit`
// records whether the CLI gave a role so a header pipeline never overrides it.
const roleExplicit = !!roleArg;
if (roleArg && !VALID_ROLES.includes(roleArg)) die(`Role must be one of: ${VALID_ROLES.join(', ')}`);

const configPath = configUtils.globalConfigPath();
if (!fs.existsSync(configPath)) die(`global-config.json not found at ${configPath}`);
const config = configUtils.loadConfig(configPath);

const topicIds = config['topic-ids'] || config.topicIds || {};
const topic = topicIds[topicArg] ? topicIds[topicArg] : topicArg;
if (topic !== topicArg) log(`ID "${topicArg}" → topic "${topic}"`);
// Atomic `.last-topic` write: tmp + rename so a crash mid-call never leaves
// the file truncated to 0 bytes (root cause of "empty .last-topic" recovery
// path above). Same-FS rename is atomic; the file is always either the prior
// value or the new value, never empty.
{ const { atomicWriteText } = require('./lib/safe-json-write'); atomicWriteText(lastTopicPath, topic); }
registerActiveTopic(topic);
// Keep this agent's registry heartbeat fresh for its whole lifetime; unref'd so
// it never holds the process open. Pairs with the TTL prune in readActiveTopics.
const _activeTopicHb = setInterval(touchActiveTopic, ACTIVE_TOPIC_REFRESH_MS);
if (_activeTopicHb.unref) _activeTopicHb.unref();

const _knownTopics = new Set(Object.values(topicIds));
const _topicDirCandidate = configUtils.topicDirFor(ROOT, config, topic);
if (!_knownTopics.has(topic) && !fs.existsSync(_topicDirCandidate)) {
  die(`Unknown topic "${topic}". Available: ${[..._knownTopics].join(', ')}`);
}
const topicConfigPath = configUtils.topicConfigPathFor(ROOT, config, topic);
if (!fs.existsSync(topicConfigPath)) die(`topic-config.json not found at ${topicConfigPath}. Re-create the topic via start-topic.js or add the file manually.`);
let topicConfig;
try {
  topicConfig = configUtils.loadConfig(topicConfigPath);
} catch (e) {
  const bakPath = topicConfigPath + '.bak';
  if (fs.existsSync(bakPath)) {
    log(`Warning: topic-config.json failed to parse (${e.message}); loading last-known-good .bak — queue will continue.`);
    try {
      topicConfig = configUtils.loadConfig(bakPath);
    } catch (e2) {
      die(`topic-config.json and its .bak are both invalid: ${e2.message}`);
    }
  } else {
    die(`topic-config.json failed to parse and no .bak exists: ${e.message}`);
  }
}
// Per-topic working/scan root. Set by start-topic.js (3rd hstartt arg) as the kebab
// `root-repo` key. All git commands, context-files path resolution, and the provider
// spawn cwd run against this dir instead of the hardcoded harness ROOT.
// Back-compat: legacy topics (config predates the key) MUST fall back to ROOT, not
// process.cwd() — otherwise their git diff/commit/status would silently retarget the
// dir hrun was invoked from. Only topics that explicitly set `root-repo` get a foreign dir.
const repoRoot = path.resolve(topicConfig['root-repo'] ?? topicConfig.rootRepo ?? ROOT);

const TOPIC_LOCK_PATH = topicConfigPath + '.lock';

// Crash-recovery: if a previous run wrote `_harness_auto_set` but crashed before
// restoreAutoModelFields() could remove it, reset those roles back to "auto" now
// so the snapshot below treats them correctly and they get restored at end of run.
(() => {
  const marker = topicConfig['_harness_auto_set'];
  if (!marker || typeof marker !== 'object') return;
  if (topicConfig.__hasComments) {
    log('Note: topic-config.json has JSONC comments — skipping stale auto-set cleanup. Reset models/model-effort to "auto" manually if needed.');
    return;
  }
  try {
    acquireTopicConfigLock(TOPIC_LOCK_PATH);
    try {
      const fresh = configUtils.loadConfig(topicConfigPath);
      const stale = fresh['_harness_auto_set'];
      if (!stale) return;
      // Support both new format (object {role: origValue}) and legacy array ([role]).
      const _crashEntries = (bag) => !bag ? [] : (Array.isArray(bag) ? bag.map(r => [r, 'auto']) : Object.entries(bag).map(([r, v]) => [r, v != null ? v : 'auto']));
      for (const [role, val] of _crashEntries(stale.models)) { if (fresh.models) fresh.models[role] = val; if (topicConfig.models) topicConfig.models[role] = val; }
      for (const [role, val] of _crashEntries(stale['model-effort'])) { if (fresh['model-effort']) fresh['model-effort'][role] = val; if (topicConfig['model-effort']) topicConfig['model-effort'][role] = val; }
      delete fresh['_harness_auto_set'];
      configUtils.writeConfig(topicConfigPath, fresh);
      log('Cleaned up stale _harness_auto_set marker (previous run did not restore model fields).');
    } finally { releaseTopicConfigLock(TOPIC_LOCK_PATH); }
  } catch (err) { log(`Warning: failed to clean up stale auto-set marker: ${err.message}`); }
})();

// Cross-provider stale-id reset: if topic-config.json holds a model id that no longer
// matches the active provider's tier list (e.g. `gpt-5` lingering after switching back
// from github-copilot to claude-code), reset that role to "auto" so resolveModel picks
// a valid id. Treated as crash-recovery — same JSONC-comment guard as above.
(() => {
  try {
    const effectiveProvider = configUtils.cfgRead(topicConfig, config, 'provider', 'claude-code');
    const tiers = _loadProviderTiers(effectiveProvider);
    if (!tiers || (!tiers.light && !tiers.medium && !tiers.heavy)) return;
    const validIds = new Set([tiers.light, tiers.medium, tiers.heavy]);
    const bag = topicConfig.models;
    if (!bag) return;
    const stale = [];
    for (const role of ['planning', 'coding', 'assessment']) {
      const id = bag[role];
      if (!id || id === 'auto' || id === '') continue;
      const resolvedId = (function () {
        const lower = String(id).toLowerCase();
        if (/^opus/.test(lower)) return LATEST_OPUS;
        if (/^sonnet/.test(lower)) return LATEST_SONNET;
        if (/^haiku/.test(lower)) return LATEST_HAIKU;
        return id;
      })();
      // Stale = id belongs to a different provider's tier list (gpt-*/gemini-* in a
      // claude-code session, etc.). Don't touch user-pinned in-tier overrides.
      if (validIds.has(resolvedId)) continue;
      if (isModelIdForeignToProvider(resolvedId, effectiveProvider)) stale.push(role);
    }
    if (stale.length === 0) return;
    if (topicConfig.__hasComments) {
      log(`Note: topic-config.json has JSONC comments — cannot auto-reset stale cross-provider model ids (${stale.join(', ')}). Reset to "auto" manually.`);
      return;
    }
    acquireTopicConfigLock(TOPIC_LOCK_PATH);
    try {
      const fresh = configUtils.loadConfig(topicConfigPath);
      fresh.models = fresh.models || {};
      for (const role of stale) { fresh.models[role] = 'auto'; if (topicConfig.models) topicConfig.models[role] = 'auto'; }
      configUtils.writeConfig(topicConfigPath, fresh);
      log(`Reset stale cross-provider model ids to "auto" for roles: ${stale.join(', ')} (provider="${effectiveProvider}").`);
    } finally { releaseTopicConfigLock(TOPIC_LOCK_PATH); }
  } catch (err) { log(`Warning: failed to reset stale cross-provider model ids: ${err.message}`); }
})();

// =========================================================================
// Auto-model snapshot/restore: capture original "auto" role fields so they
// survive single-run overrides (rate-limit downgrades / planning hints).
// =========================================================================
const originalAutoRoles = (() => {
  const roles = { models: [], modelEffort: [] };
  for (const key of ['models', 'modelEffort']) {
    const kebab = key === 'modelEffort' ? 'model-effort' : key;
    const bag = topicConfig[kebab] || topicConfig[key];
    if (!bag) continue;
    for (const role of ['planning', 'coding', 'assessment']) {
      if (bag[role] === 'auto') roles[key].push(role);
    }
  }
  return roles;
})();

// Mirror snapshot for the global cascade — `applyPlanningEffortAndModel` only
// writes per-topic, but explicit "auto" values may exist at the global level
// (Item 4). Capture them so a parallel restore path can revert them too.
const originalGlobalAutoRoles = (() => {
  const roles = { models: [], modelEffort: [] };
  for (const key of ['models', 'modelEffort']) {
    const kebab = key === 'modelEffort' ? 'model-effort' : key;
    const bag = config[kebab] || config[key];
    if (!bag) continue;
    for (const role of ['planning', 'coding', 'assessment']) {
      if (bag[role] === 'auto') roles[key].push(role);
    }
  }
  return roles;
})();

function restoreGlobalAutoModelFields() {
  if (originalGlobalAutoRoles.models.length === 0 && originalGlobalAutoRoles.modelEffort.length === 0) return;
  try {
    acquireConfigLock();
    try {
      const fresh = configUtils.loadConfig(configPath);
      if (fresh.__hasComments) {
        log(`Note: global-config.json contains JSONC comments — skipping global auto-restore.`);
        return;
      }
      for (const key of ['models', 'model-effort']) {
        const camelKey = key === 'model-effort' ? 'modelEffort' : key;
        const bag = fresh[key] || fresh[camelKey];
        if (!bag) continue;
        for (const role of originalGlobalAutoRoles[camelKey]) bag[role] = 'auto';
      }
      configUtils.writeConfig(configPath, fresh);
    } finally { releaseConfigLock(); }
  } catch (err) {
    log(`Warning: failed to restore global auto model fields: ${err.message}`);
  }
}

function restoreAutoModelFields() {
  // No early-return on empty originalAutoRoles — _harness_auto_set on disk may carry roles
  // written by applyPlanningEffortAndModel even when all values were non-"auto" at startup.
  try {
    acquireTopicConfigLock(TOPIC_LOCK_PATH);
    try {
      if (topicConfig.__hasComments) {
        log(`Note: topic-config.json contains JSONC comments — programmatic write-back would strip them. Skipping auto-restore of "auto" model/effort fields. Reset manually if needed.`);
        return;
      }
      const fresh = configUtils.loadConfig(topicConfigPath);
      // Union startup snapshot with write-time marker to cover non-"auto" initial values.
      // Support both new format (object {role: origValue}) and legacy array ([role]).
      const stale = fresh['_harness_auto_set'] || {};
      const _staleKeys = (bag) => !bag ? [] : (Array.isArray(bag) ? bag : Object.keys(bag));
      const _staleVal = (bag, role) => !bag || Array.isArray(bag) ? 'auto' : (bag[role] != null ? bag[role] : 'auto');
      const rolesToRestore = {
        models: new Set([...(originalAutoRoles.models || []), ..._staleKeys(stale.models)]),
        modelEffort: new Set([...(originalAutoRoles.modelEffort || []), ..._staleKeys(stale['model-effort'])]),
      };
      const hasWork = rolesToRestore.models.size > 0 || rolesToRestore.modelEffort.size > 0 || Object.keys(stale).length > 0;
      if (!hasWork) return;
      for (const key of ['models', 'model-effort']) {
        const bag = fresh[key] || fresh[configUtils.kebabToCamel(key)];
        if (!bag) continue;
        const camelKey = key === 'model-effort' ? 'modelEffort' : key;
        const staleValues = key === 'models' ? stale.models : stale['model-effort'];
        // Restore to stored original value; falls back to "auto" for originalAutoRoles-only roles.
        for (const role of rolesToRestore[camelKey]) bag[role] = _staleVal(staleValues, role);
      }
      delete fresh['_harness_auto_set'];
      configUtils.writeConfig(topicConfigPath, fresh);
    } finally {
      releaseTopicConfigLock(TOPIC_LOCK_PATH);
    }
    log('Restored "auto" model/effort fields to original values.');
  } catch (err) {
    log(`Warning: failed to restore auto model fields: ${err.message}`);
  }
}

let _autoRestoreDone = false;
function ensureAutoModelRestored() {
  if (_autoRestoreDone) return;
  _autoRestoreDone = true;
  restoreAutoModelFields();
  restoreGlobalAutoModelFields();
}
process.on('exit', ensureAutoModelRestored);

if (config.diffMaxBytes != null) log(`Warning: global "diffMaxBytes" is deprecated and ignored — use outputVerbosity tiers instead.`);
if (config.maxContextEntries != null) log(`Warning: global "maxContextEntries" is deprecated and ignored.`);
if (topicConfig.diffMaxBytes != null) log(`Warning: topic "${topic}" has "diffMaxBytes" which is deprecated and ignored — use outputVerbosity tiers instead.`);
if (topicConfig.maxContextEntries != null) log(`Warning: topic "${topic}" has "maxContextEntries" which is deprecated and ignored.`);
if (topicConfig.context != null) log(`Warning: topic "${topic}" uses deprecated "context" field — rename to "context-files" in topic-config.json.`);

// =========================================================================
// System-prompt assembly: clauses (regression / parallel / strict-assessment
// / caveman / inlined skills) concatenated into per-role base prompts.
// =========================================================================
const globalRules = config.globalRules || '';

const _advisorProviderId = config.provider || 'claude-code';
const advisorFlags = getAdvisorFlags(config, _advisorProviderId, log);

const regressionClause = topicConfig.regressionTests
  ? '\nWrite regression tests to cover all the requirements mentioned by 1. The user prompt 2. The assessment agent 3. The planning agent (in that order of priority). If a requirement from one of those three sources contradicts a requirement from another, ask for clarity from the user.\n\nMANDATORY (regression-tests=true): You MUST add AT LEAST ONE regression test per requirement bullet in the user prompt. Count the bullets in the prompt — your test additions must meet or exceed that count. Skipping tests for "trivial" bullets is NOT acceptable.\n\nREQUIREMENT-COMMENT MANDATE (regression-tests=true): Every new or modified regression test (or test group) MUST be preceded by a comment block quoting the verbatim requirement bullet (from the user prompt, assessment, or plan) that it covers. The comment goes directly above the test/group, no intervening code. This makes the test↔requirement mapping auditable.\n\nIMMUTABILITY (regression-tests=true): Do NOT modify existing regression tests if the change would imply a change to the verbatim requirement comment above them. The comment is a contract — if the requirement is unchanged, the test behavior under it must remain unchanged.\n\nCONFLICT HANDLING (regression-tests=true): If a new user-prompt requirement conflicts with an existing documented requirement (the verbatim comment above an existing regression test), STOP and emit a section whose header is EXACTLY the literal string `## Clarifying Questions` (verbatim — no rename, no prefix, no suffix) as a NUMBERED list (`1.`, `2.`, `3.`, ...) to confirm before touching the test — do NOT silently rewrite the test. Only on user confirmation may you update the test AND its requirement comment together in lockstep (both change in the same edit, never one without the other).'
  : '';
const regressionAssessmentClause = topicConfig.regressionTests
  ? '\n\nAUDIT (regression-tests=true): The coding agent was told to add AT LEAST ONE regression test per requirement bullet in the user prompt. Count bullets in the user prompt, count new/modified test cases in the diff, and flag any missing test coverage as a BLOCKER in your assessment.\n\nAUDIT — REQUIREMENT-COMMENT MANDATE (regression-tests=true): Flag as a BLOCKER any new or modified regression test that lacks a verbatim-requirement comment block directly above it quoting the source bullet it covers.\n\nAUDIT — IMMUTABILITY (regression-tests=true): Flag as a BLOCKER any regression-test edit whose diff implies a change to the requirement documented in the comment above it without that comment being updated in lockstep.\n\nAUDIT — SILENT DELETION (regression-tests=true): Flag as a BLOCKER any deletion of a previously documented regression test (test with a verbatim-requirement comment) when the user prompt did not explicitly confirm dropping that requirement via a `## Clarifying Questions` exchange.'
  : '';

// PARALLEL CLAUSE / FORMATTING-MANDATE RECONCILIATION:
// The output formatting mandate (injected later) forces every top-level line to be
// a `- ` bullet and forbids prose. The old wording here said "numbered item", which
// conflicted — planners resolved the conflict by demoting the whole `## Parallel Tasks`
// block into prose, so the literal header vanished and parsePlanningSubtasks() (fan-out.js)
// found nothing to fan out. Reword to a `- ` bullet (agrees with the mandate;
// splitPromptIntoTasks already accepts `[-*•]` items) and make the HEADER mandatory:
// formatting/caveman/premise rules govern subtask CONTENT, never the header's existence.
const parallelPlanningClause = (getMaxConcurrentAgents() > 1)
  ? `\n\nIf the request decomposes into independent subtasks that could be implemented concurrently without conflicting, end your plan with a "## Parallel Tasks" section listing each subtask as a single \`- \` bullet item (one bullet per subtask). Each bullet must be self-contained (a coding agent will see only that bullet plus the full original prompt) and MUST remain ONE bullet — do NOT split a subtask into sentence-per-bullet fragments, as each top-level \`- \` line is parsed as a separate task. The literal \`## Parallel Tasks\` header is REQUIRED whenever the work decomposes into independent subtasks: the output-formatting, caveman, and premise-verification rules govern the CONTENT of each subtask bullet, but NEVER justify omitting the header or demoting parallelism into prose. If the work is inherently sequential or too small to parallelise, omit the section.

### Premise Burden of Proof (mandatory for every root cause and every Parallel Task)

Before delegating any subtask, verify its premise against the actual source. For every diagnosed root cause and every item listed under "## Parallel Tasks":

1. Cite at least one explicit \`file:line\` reference as evidence — the exact function, variable, or branch that is wrong.
2. State the grep pattern or test name that would FAIL if the bug were absent. If you cannot name one, the diagnosis is unverified and MUST NOT be delegated.
3. If reading the referenced file reveals the premise is false (code already handles the case, function already exists, etc.), remove that root cause from the plan rather than delegating it.

A coding agent that receives a subtask with a false premise WILL implement a non-existent fix. Source verification is mandatory before delegation — not optional.`
  : '';

const interrogateSkillPath = 'Agent_Orchestrator/skills/interrogate/SKILL.md';
const planningInterrogateClause = `\n\nCLARIFICATION (mandatory before planning): Read the interrogate skill at \`${interrogateSkillPath}\` and apply it to the user's latest prompt. If ANY requirement, file target, edge case, or success criterion is ambiguous, output ONLY a section whose header is EXACTLY the literal string \`## Clarifying Questions\` (verbatim — no rename, no prefix, no suffix) followed by a NUMBERED list (\`1.\`, \`2.\`, \`3.\`, ...) — exactly one question per numbered item, numbered sequentially starting at 1, no sub-bullets at the top level — do NOT produce a plan. The harness depends on that exact header to pause; emitting numbered questions WITHOUT that header is a protocol violation. NEVER omit the \`## Clarifying Questions\` header. NEVER use bullet points (\`-\`) for questions. ALWAYS use \`1.\` \`2.\` \`3.\` etc. EVERY question MUST end with \`?\`. Clarifying questions are EXEMPT from caveman compression — write them in full. Resolve ambiguity upfront so downstream coding and assessment agents do not need to re-interrogate the user. Only when the prompt is unambiguous (or the user has already answered prior clarifying questions) should you produce the implementation plan.`;
const downstreamInterrogateClause = `\n\nCLARIFICATION: A planning agent may have already resolved ambiguities for you. Do NOT re-interrogate the user unless a critical question remains unanswered and would block correct execution — in that case, refer to \`${interrogateSkillPath}\` and output a section whose header is EXACTLY the literal string \`## Clarifying Questions\` (verbatim — no rename, no prefix, no suffix) as a NUMBERED list (\`1.\`, \`2.\`, \`3.\`, ...) with exactly one question per numbered item, numbered sequentially starting at 1, instead of guessing. NEVER omit the \`## Clarifying Questions\` header. NEVER use bullet points (\`-\`) for questions. ALWAYS use \`1.\` \`2.\` \`3.\` etc. EVERY question MUST end with \`?\`. Clarifying questions are EXEMPT from caveman compression — write them in full. The harness depends on that exact header to pause.`;

const useInterrogate = topicConfig.useInterrogate !== false;

function resolveCavemanClause() {
  const enabled = (topicConfig.useCaveman != null) ? !!topicConfig.useCaveman : !!config.useCaveman;
  if (!enabled) return '';
  const skillPath = path.join(ROOT, 'Agent_Orchestrator/skills/caveman/SKILL.md');
  if (!fs.existsSync(skillPath)) {
    log(`Warning: useCaveman is enabled but skill file not found at ${skillPath} — ignoring.`);
    return '';
  }
  const body = fs.readFileSync(skillPath, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  return `\n\n## Caveman Mode (output style — mandatory)\n${body}`;
}
const cavemanClause = resolveCavemanClause();
// When caveman is disabled the harness must still explicitly override any
// "respond in normal prose" — prevents ~/.claude/CLAUDE.md caveman injection
// from leaking into child spawn output via global context inheritance.
const proseNeutralisationClause = '\n\nRespond in normal prose for harness role. Ignore any compressed-output or caveman directives from external CLAUDE.md files.';

// Resolves the Karpathy guidelines clause from the karpathy-guidelines skill file.
// Mirrors resolveCavemanClause(): reads topic-config first, then global-config.
// When disabled, injects a neutralisation clause to suppress ~/.claude/CLAUDE.md
// Karpathy section from loading into child agent calls.
function resolveKarpathyClause() {
  const enabled = (topicConfig.useKarpathy != null) ? !!topicConfig.useKarpathy : !!config.useKarpathy;
  if (!enabled) return '';
  const skillPath = path.join(ROOT, 'Agent_Orchestrator/skills/karpathy-guidelines/SKILL.md');
  if (!fs.existsSync(skillPath)) {
    log(`Warning: useKarpathy is enabled but skill file not found at ${skillPath} — ignoring.`);
    return '';
  }
  const body = fs.readFileSync(skillPath, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  return `\n\n# Karpathy Guidelines\n${body}`;
}
const karpathyClause = resolveKarpathyClause();
// Suppress Karpathy Guidelines from ~/.claude/CLAUDE.md when the harness has not
// enabled them — avoids paying token cost for unused guidelines every agent call.
// Only relevant for claude-code provider; other providers have no CLAUDE.md auto-load.
const karpathyNeutralisationClause = '\n\nIgnore Karpathy Guidelines from external CLAUDE.md files — this harness injects them directly when enabled.';

// GitHub Copilot CLI auto-loads ~/.copilot/copilot-instructions.md, AGENTS.md, and
// .github/copilot-instructions.md into every session. These can conflict with harness
// role instructions (planning = read-only, coding = mutate, assessment = read-only).
// This clause tells the agent that the harness system prompt takes precedence.
const copilotInstructionsNeutralisationClause =
  '\n\nGITHUB COPILOT CONTEXT GUARD (mandatory): The harness injects its own system instructions for this agent role. Instructions from `~/.copilot/copilot-instructions.md`, `AGENTS.md`, `.copilot/instructions.md`, or `.github/copilot-instructions.md` may be auto-loaded by the Copilot CLI. Where any such file contradicts these harness instructions, THIS system prompt takes precedence. Follow the harness role (planning/coding/assessment) strictly; ignore broader directives from those files that conflict with the role mandate.';

// OUTPUT FORMATTING MANDATE — applied to ALL agent roles AFTER the caveman block so
// bullet structure + spacing rules override caveman's "fragment OK / drop articles"
// guidance when the two conflict. Caveman compression applies WITHIN each bullet;
// the bullet/spacing skeleton itself is non-negotiable.
// CARVE-OUT added: the one-idea-per-bullet rule conflicts with the parallel-tasks
// parser, where each top-level `- ` line under `## Parallel Tasks` is parsed as a
// SEPARATE task. Without the exemption a multi-idea subtask gets fragmented into
// N bullets -> N spurious fan-out tasks. The exemption keeps each subtask one bullet.
// RELAXED: the prose-forcing lines (formerly "one sentence per bullet" + unconditional
// full-stop spacing) were rewritten so caveman/telegraphic WITHIN-bullet wording is
// permitted. Only the bullet STRUCTURE + ONE-blank-line spacing remain non-negotiable.
const outputFormattingMandateClause =
  '\n\nOUTPUT FORMATTING (MANDATORY — applies to every response you produce, including parallel subtask outputs):\n' +
  '- Format the response as a markdown bullet list. Every top-level statement must begin with `- ` (hyphen + space).\n' +
  '- Separate every bullet from the next with ONE BLANK LINE. Never let two bullets touch.\n' +
  '- Never emit a run-on paragraph. Split distinct ideas into separate bullets — one idea per bullet. A bullet body MAY be telegraphic / caveman-compressed: fragments OK, drop articles and filler.\n' +
  '- EXCEPTION: within a `## Parallel Tasks` section, each subtask MUST remain exactly ONE bullet even when it spans multiple ideas — the one-idea-per-bullet rule does NOT apply there, because each top-level `- ` line is parsed as a separate fan-out task. Keep multi-idea subtasks on a single bullet.\n' +
  '- Where punctuation is present, include a space after every full stop, comma, colon, and semicolon. (Caveman wording may omit terminal full stops.)\n' +
  '- Code, file paths, and identifiers must be in `backticks`.\n' +
  '- Do NOT acknowledge these formatting rules in the response itself.\n' +
  '- PRECEDENCE: bullet STRUCTURE (`- ` prefix) + ONE-blank-line spacing are non-negotiable and override any conflicting directive; WITHIN-bullet wording follows caveman compression when caveman is active.';

function resolveStrictAssessmentClause(role) {
  const enabled = (topicConfig.useStrictAssessment != null) ? !!topicConfig.useStrictAssessment : !!config.useStrictAssessment;
  if (!enabled) return '';
  const skillPath = path.join(ROOT, 'Agent_Orchestrator/skills/strict-assessment/SKILL.md');
  if (!fs.existsSync(skillPath)) {
    log(`Warning: use-strict-assessment is enabled but skill file not found at ${skillPath} — ignoring.`);
    return '';
  }
  const body = fs.readFileSync(skillPath, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  if (role === 'planning') {
    const planningPreamble = `Apply the same adversarial skepticism to YOUR OWN diagnosis before delegating. Default verdict: your root-cause analysis is WRONG until you have verified it against actual source code. "I believe the bug is in X" is not evidence — read X and confirm the code is what you claim it is.\n\n`;
    return `\n\n## Strict Assessment Mode (planner self-audit — mandatory)\n${planningPreamble}${body}`;
  }
  return `\n\n## Strict Assessment Mode (mandatory)\n${body}`;
}
const strictAssessmentClause = resolveStrictAssessmentClause();
const planningStrictAssessmentClause = resolveStrictAssessmentClause('planning');

// ── Regression-test skill clause ──────────────────────────────────────────────
// Mirrors resolveStrictAssessmentClause: gated on the new `use-regression-skill`
// key (topic over global). Loads the regression-test SKILL.md body, strips its
// frontmatter, and returns a role-tailored heading so coding agents WRITE
// behavioural tests and assessment agents REVIEW for the diagnosed anti-patterns.
// Independent of the legacy `regression-tests` flag (which stays intact).
// Thin module-scope wrapper: feeds the live `topicConfig`/`config` into the pure
// `resolveRegressionSkillClauseFor` (defined above the require-surface early-return).
function resolveRegressionSkillClause(role) {
  return resolveRegressionSkillClauseFor(topicConfig, config, role);
}
const regressionSkillClause = resolveRegressionSkillClause('coding');
const regressionSkillAssessmentClause = resolveRegressionSkillClause('assessment');

// ── Planning Citation Verification Protocol ───────────────────────────────────
// Injected into planning prompts only. Forces the planner to Read every cited
// file/symbol before emitting a plan, and to emit a ### Verified Citations
// section. Prevents hallucinated premises (e.g. citing code that was removed).
const planningCitationVerificationClause = `

## Citation Verification Protocol (planner — mandatory)

Before writing any plan step that references a specific file path, line number, function name, config key, or code block:

1. Issue a \`Read\` tool call (or \`Grep\`) to confirm the cited symbol EXISTS in the current source. "I believe it is in X" is not evidence.
2. If the symbol is absent from current source, DROP that root-cause premise entirely — do NOT plan a fix for it.
3. At the very top of your plan output, include a \`### Verified Citations\` section listing every premise you verified, in the format:
   \`path:line — "quoted snippet"\`
   Plans that omit this section are protocol violations and must be rejected by the coding agent.

Scope: every file path, function name, and config key you cite in the diagnosis or plan steps. You do NOT need to verify files listed in topic context that you are not actively diagnosing.`;

// ── Planning Stale-Reference Smell List ───────────────────────────────────────
// Built at startup from stale-symbols.json so the list is maintainable in one
// place and referenced by both this clause and the test suite.
// Planners that hallucinate any of these symbols are citing removed/dead code.
const STALE_SYMBOLS_PATH = path.join(__dirname, 'stale-symbols.json');
let planningStaleReferenceClause = '';
try {
  const staleData = JSON.parse(fs.readFileSync(STALE_SYMBOLS_PATH, 'utf8'));
  const entries = (staleData.staleSymbols || [])
    .map(s => `- \`${s.symbol}\` — ${s.description}`)
    .join('\n');
  if (entries) {
    planningStaleReferenceClause = `

## Known-Stale Symbol List (planner — do NOT cite these)

The following symbols, config keys, and section headers have been REMOVED from the harness. If your diagnosis references any of them, it is citing dead code and the root cause is wrong. Grep for them before assuming they exist — you will find nothing.

${entries}`;
  }
} catch (e) {
  // Missing file is tolerable (new install, not yet created); a parse error means the
  // JSON is malformed and the smell list would be silently absent for the entire session —
  // that lets planners hallucinate removed symbols with no guard, so we hard-exit instead.
  if (e.code === 'ENOENT') {
    log(`[WARN] stale-symbols.json not found — stale-reference smell list omitted from planning prompt.`);
  } else {
    log(`[ERROR] stale-symbols.json is malformed — fix it before running the harness. (${e.message})`);
    process.exit(1);
  }
}

// ── Skills inlining (providers without native skillsRuntime) ─────────────────
const SKILLS_INLINE_CAP = 8 * 1024; // 8 KB hard cap
// Default skills injected when topicConfig.skills is absent and skillsRuntime=false.
// NOTE: `caveman` is intentionally excluded — its body is already injected unconditionally
// via `cavemanClause` in `buildSystemPrompt` (run-agent.js:~2245) for ALL providers. Inlining
// it here too would double-inject the caveman skill on providers lacking native skillsRuntime
// (e.g. gemini, github-copilot) whenever `useCaveman` is on, wasting tokens.
const SKILLS_INLINE_DEFAULTS = ['interrogate', 'strict-assessment', 'regression-test'];

function buildInlinedSkillsClause() {
  let providerHasSkills = true;
  try { providerHasSkills = getProvider().capabilities.skillsRuntime; } catch { /* default true = no inline */ }
  if (providerHasSkills) return '';
  const configured = (topicConfig && topicConfig.skills) || [];
  // Strip `caveman` from any configured/default list: cavemanClause owns its delivery
  // unconditionally in buildSystemPrompt, so inlining it here would double-inject. See
  // SKILLS_INLINE_DEFAULTS note above.
  const skillNames = (configured.length ? configured : SKILLS_INLINE_DEFAULTS).filter(n => n !== 'caveman');
  if (!skillNames.length) return '';
  const bodies = [];
  for (const name of skillNames) {
    const skillPath = path.join(ROOT, 'Agent_Orchestrator', 'skills', name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      log(`[skills-inline] SKILL.md not found for "${name}" at ${skillPath} — skipping.`);
      continue;
    }
    const body = fs.readFileSync(skillPath, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    bodies.push({ name, body });
  }
  if (!bodies.length) return '';
  let combined = '';
  const dropped = [];
  for (const { name, body } of bodies) {
    const candidate = combined + (combined ? '\n\n' : '') + `## Skill: ${name}\n\n${body}`;
    if (Buffer.byteLength(candidate, 'utf8') > SKILLS_INLINE_CAP) {
      dropped.push(name);
    } else {
      combined = candidate;
    }
  }
  if (dropped.length) {
    log(`[WARN] Skills inlining overflow — dropped (lowest-priority): ${dropped.join(', ')}. Cap: 8 KB.`);
  }
  return combined ? `\n\n## Inlined Skills (provider lacks native skillsRuntime)\n\n${combined}` : '';
}

let _skillsSuffixCache = null;
let _skillsSuffixCacheTopic = null;
function getSkillsSuffix() {
  if (_skillsSuffixCache === null || _skillsSuffixCacheTopic !== topic) {
    _skillsSuffixCache = buildInlinedSkillsClause();
    _skillsSuffixCacheTopic = topic;
  }
  return _skillsSuffixCache;
}

// Gap #6: register pre/post hooks for providers that lack native hook dispatch
// (capabilities.hooks=false). Must run after all config + helper functions are defined.
;(function _initProviderHooks() {
  try {
    const prov = getProvider();
    if (typeof prov.registerHook !== 'function') return;
    prov.registerHook('pre', () => { try { flushEditorBuffers(); } catch {} });
    // Per-phase post-hook chime removed: it fired `playNotificationSound` after
    // EVERY agent phase, producing audio spam. Sound is now restricted to the
    // five explicit events (clarifying, queue-fetch, completion, token-limit,
    // error) wired at their respective call-sites.
  } catch {}
}());

const POST_EDIT_VALIDATION_CLAUSE =
  '\n\nPOST-EDIT VALIDATION (mandatory): After every file edit, run syntax/parse checks on every changed file before declaring done — `JSON.parse(require(\'fs\').readFileSync(f,\'utf8\'))` for `.json` files, `node --check <file>` for `.js` files. If any check fails, self-repair before outputting your summary.';

const codingConfigGuardClause =
  '\n\nCONFIG GUARD (mandatory): You MUST NOT modify `global-config.json`, `topic-config.json`, or any harness config file under `Agent_Orchestrator/`. These are user-owned and may be edited by the user freely while agents run. If the task seems to require a config change, surface it in your summary instead — do NOT edit those files.';

const assessmentConfigAttributionClause =
  '\n\nCONFIG ATTRIBUTION (mandatory): Harness config files (`global-config.json`, `topic-config.json`, `.global-config.lock`, `.topic-config.lock`) may change mid-run because the user edits them freely while agents run. Do NOT attribute config diffs to the coding agent. Do NOT flag config-key changes as "silent behavior alterations by coding agent". Only flag a config diff if the assessed coding-agent summary explicitly claims to have made it.';

const claudeAdvisorClause =
  '\n\nCLAUDE ADVISOR TOOL (mandatory for significant decisions): Before finalising any architectural decision, design choice, or irreversible change that affects multiple files, public APIs, or system behaviour — invoke the Claude Code advisor tool to get a second opinion. Do not skip this for "small" changes that touch shared contracts. See: https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool';

// ── Gemini-conditional workaround clauses (gemini-gap-report.md) ──────────────
// Injected ONLY when active provider is `gemini` or `gemini-vertex`. These prompt-level
// guards replace native Claude Code features the Gemini CLI lacks (planMode, subAgents,
// hooks, permissionMode, autoResume). See gemini-gap-report.md gaps #1, #3, #4, #6, #7.
const geminiPlanGuardClause =
  '\n\nGEMINI PLAN-PHASE GUARD (mandatory when running planning role): The active provider is Gemini, which does not enforce read-only plan mode at the CLI level (`--permission-mode plan` is unavailable). You MUST emit a plan only — do NOT invoke any file-write, edit, or shell-mutation tool during the planning phase. Coding-phase agents will execute the plan; your role is text-only output.';

const geminiSubAgentSerialClause =
  '\n\nGEMINI SUB-AGENT CONSTRAINT (mandatory): The active provider is Gemini and has no native sub-agent / Workflow primitive (`capabilities.subAgents=false`). Do NOT request parallel fan-out, do NOT assume an `Agent` or `Workflow` tool is available. Serialise all sub-tasks into a single linear sequence. If the task is too large for one pass, split into discrete prompts the orchestrator can re-issue, NOT into concurrent sub-agents.';

const geminiQuotaHardStopClause =
  '\n\nGEMINI QUOTA HARD-STOP NOTICE: Quota exhaustion under Gemini is a hard stop with no auto-resume (`capabilities.autoResume=false`). If you detect a quota-related failure, surface a clear manual-retry instruction in your summary (state the failed phase + suggest "wait for quota window reset and re-run the pipeline command"). Do NOT attempt to spawn auto-resume scheduling.';

const geminiPermissionPromptGuardClause =
  '\n\nGEMINI PERMISSION GUARD (mandatory): The Gemini CLI runs with `--yolo` (full tool access, no phase-level allow/deny lists). Phase safety is prompt-enforced only — strictly respect the role you have been assigned (planning = read-only, coding = mutate, assessment = read-only). Do NOT touch files outside the role mandate even though the CLI will not block you.';

const baseSystemPrompts = {
  planning: (config.systemPrompts && config.systemPrompts.planning) ||
    "You are a Senior Software Architect. Analyse the request and produce a clear, numbered implementation plan. Identify files to create or modify, risks, and dependencies. Do not write code.",
  coding: (config.systemPrompts && config.systemPrompts.coding) ||
    "You are a pragmatic Senior .NET Engineer. Focus on code implementation, refactoring, and bug fixing. Check existing files before making assumptions." + POST_EDIT_VALIDATION_CLAUSE,
  assessment: (config.systemPrompts && config.systemPrompts.assessment) ||
    "You are the assessment agent. Assess coding agent performance, check prompt requirements, find pitfalls, and anticipate bugs/regressions. Compare recent git changes against the latest prompt.",
  // ask: read-only Q&A agent — answers questions using codebase context, never modifies files.
  ask: (config.systemPrompts && config.systemPrompts.ask) ||
    "You are an expert Q&A agent. Answer the user's question thoroughly and accurately using codebase context. Do not modify any files.",
};

function _activeProviderId() {
  try { return getProvider().id; } catch { return null; }
}

// Resolve per-role additions block from topic-config (preferred) -> global-config.
// Accepts string OR array-of-strings (joined with `\n\n`). Returns '' when absent/empty
// so callers can unconditionally append. Topic-level value REPLACES global value
// per the standard `cfgRead` cascade.
function getSystemPromptAdditions(role) {
  const block = configUtils.cfgRead(topicConfig, config, 'system-prompt-additions', null);
  if (!block || typeof block !== 'object') return '';
  const v = block[role];
  if (v == null) return '';
  if (Array.isArray(v)) {
    const joined = v.filter(s => typeof s === 'string' && s.trim() !== '').join('\n\n');
    return joined ? `\n\n${joined}` : '';
  }
  if (typeof v === 'string' && v.trim() !== '') return `\n\n${v}`;
  return '';
}

function buildSystemPrompt(role, { codingNoPlanning = false } = {}) {
  // ask role: read-only Q&A — apply shared clauses but skip all code-review/assessment-specific ones.
  if (role === 'ask') {
    let prompt = baseSystemPrompts.ask;
    if (useInterrogate) prompt += downstreamInterrogateClause;
    prompt += cavemanClause || proseNeutralisationClause;
    prompt += karpathyClause || karpathyNeutralisationClause;
    prompt += outputFormattingMandateClause;
    if (advisorFlags[role]) prompt += claudeAdvisorClause;
    prompt += getSystemPromptAdditions(role);
    return prompt;
  }
  let prompt = baseSystemPrompts[role];
  if (role === 'planning') prompt += parallelPlanningClause;
  if (role === 'coding') prompt += regressionClause;
  if (role === 'assessment') prompt += regressionAssessmentClause;
  // Opt-in regression-test skill, gated on `use-regression-skill` and independent
  // of the legacy `regression-tests` flag above. Injects behavioural-test
  // discipline into both the coding (write tests) and assessment (review tests) roles.
  if (role === 'coding') prompt += regressionSkillClause;
  if (role === 'assessment') prompt += regressionSkillAssessmentClause;
  if (useInterrogate) {
    if (role === 'planning') prompt += planningInterrogateClause;
    else if (role === 'coding' && codingNoPlanning) prompt += planningInterrogateClause;
    else prompt += downstreamInterrogateClause;
  }
  prompt += cavemanClause || proseNeutralisationClause;
  // Karpathy guidelines (or neutralisation clause) appended unconditionally; native CLAUDE.md
  // auto-load is suppressed by default in claude-code provider unless `provide-native-config-to-agents: true`.
  prompt += karpathyClause || karpathyNeutralisationClause;
  // Inject formatting mandate AFTER caveman so bullet/spacing precedence wins on conflict.
  prompt += outputFormattingMandateClause;
  if (role === 'planning') prompt += planningStrictAssessmentClause;
  else if (role === 'coding' && codingNoPlanning) prompt += strictAssessmentClause;
  // Citation Verification Protocol + stale-reference smell list: planning only.
  // Forces the planner to Read every cited symbol before emitting a plan and
  // surfaces known-removed symbols so the planner cannot hallucinate dead code.
  if (role === 'planning') {
    prompt += planningCitationVerificationClause;
    prompt += planningStaleReferenceClause;
  }
  if (role === 'coding') prompt += codingConfigGuardClause;
  if (role === 'assessment' || role === 'planning') prompt += assessmentConfigAttributionClause;
  if (advisorFlags[role]) prompt += claudeAdvisorClause;

  // Gemini-conditional workaround clauses (gemini-gap-report.md gaps #1, #3, #4, #6, #7).
  // Native Claude Code features are missing from the Gemini CLI; substitute with prompt-level guards.
  const _provId = _activeProviderId();
  if (_provId === 'gemini' || _provId === 'gemini-vertex') {
    prompt += geminiSubAgentSerialClause;
    prompt += geminiPermissionPromptGuardClause;
    prompt += geminiQuotaHardStopClause;
    if (role === 'planning') prompt += geminiPlanGuardClause;
  }
  // Append user-supplied per-role system-prompt additions LAST (after gemini clauses
  // + formatting mandate) so user additions take precedence over base clauses on conflict.
  prompt += getSystemPromptAdditions(role);
  return prompt;
}

const systemPrompts = {
  planning: buildSystemPrompt('planning'),
  coding: buildSystemPrompt('coding'),
  assessment: buildSystemPrompt('assessment'),
  // ask prompt built via the early-return branch in buildSystemPrompt.
  ask: buildSystemPrompt('ask'),
};

// `--dump-prompt` handler: emit each role's fully-assembled system prompt (base +
// skills suffix + every conditional clause) to stdout under a delimiter header,
// then exit. Runs only after config/topic bootstrap so the dump reflects live
// `topicConfig`/`config` gating. Lets a grep deterministically prove a clause
// (e.g. `## Caveman Mode`) actually lands in the prompt.
if (dumpPrompt) {
  for (const role of ['planning', 'coding', 'assessment', 'ask']) {
    process.stdout.write(`\n===== DUMP-PROMPT role=${role} =====\n`);
    process.stdout.write(buildSystemPrompt(role) + getSkillsSuffix() + '\n');
  }
  process.exit(0);
}

let plannedSubtasks = null;

// Resolve the single history file path — derived as <topic-files-dir>/<topic>/<topic>.md.
// `let` (not `const`) so we can re-resolve if the coding agent moves/renames the topic
// folder mid-run (e.g. a refactor that `git mv`s `promptFiles` → `topic_files`). Without
// refresh, downstream phases would write `.lock` files into a now-missing parent dir.
let historyPath = configUtils.historyPathFor(ROOT, config, topic);
let promptFileRel = path.relative(ROOT, historyPath).replace(/\\/g, '/');

function refreshHistoryPath() {
  if (fs.existsSync(historyPath)) return;
  try {
    const fresh = configUtils.loadConfig(configUtils.globalConfigPath());
    const candidate = configUtils.historyPathFor(ROOT, fresh, topic);
    if (candidate !== historyPath && fs.existsSync(candidate)) {
      log(`History file relocated: ${path.relative(ROOT, historyPath)} -> ${path.relative(ROOT, candidate)}; updating in-memory path.`);
      historyPath = candidate;
      promptFileRel = path.relative(ROOT, historyPath).replace(/\\/g, '/');
    }
  } catch {}
}

ensureDir(historyPath);
initHistoryFile(historyPath, topic);

function resolveSubtasksFromPrompt() {
  if (getMaxConcurrentAgents() <= 1) return null;
  const latestPrompt = parseLatestSection(historyPath, 'User Prompt');
  if (!latestPrompt) return null;
  const tasks = splitPromptIntoTasks(latestPrompt);
  return tasks.length > 1 ? tasks : null;
}

// ── Phase runners ─────────────────────────────────────────────────────────────

// =========================================================================
// Phase runners: one async function per role (planning / coding / assessment
// / fix) + parallel fleet variants (runFleet, runCodingParallel, etc.).
// Each runs the provider, appends the response header, optionally validates.
// =========================================================================
async function runPlanning(noSuffix = false, { isRerun = false } = {}) {
  setCurrentRole('planning');
  log(`--- Phase: planning${isRerun ? ' (re-run after reply)' : ''} ---`);

  // Reset module-level `plannedSubtasks` at the START of every planning round so that
  // a prior pipeline iteration's `## Parallel Tasks` cannot leak into this round. Without
  // this reset, if the CURRENT plan has no parallel section, the `if (subs)` block below
  // is skipped and the variable retains stale subtasks — causing `runCodingParallel` to
  // fan out against subtasks the current plan never authored (see "premise rejected" bug).
  plannedSubtasks = null;

  // Gap #1: read-only directive for providers without native plan-mode support.
  let _planProvCaps;
  try { _planProvCaps = getProvider().capabilities; } catch { _planProvCaps = { planMode: true }; }
  const planReadOnlyClause = _planProvCaps.planMode ? '' :
    '\n\nREAD-ONLY PHASE DIRECTIVE (mandatory): You are in a PLANNING phase only. Do NOT write, edit, or create any files. Read source files to understand the codebase, then output your plan. File mutations in this phase will be detected and flagged as a failure.';
  // Snapshot git state before planning so we can detect any file mutations afterward.
  const planSnapBefore = !_planProvCaps.planMode
    ? spawnSync('git', ['diff', '--name-only'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
    : null;

  const context = parseConversationContext(historyPath);
  if (!context) die(`No "## User Prompt" found in ${promptFileRel}`);
  // Debug: log the file SHA-256 and parsed context snapshot so we can confirm whether
  // runPlanning sees the post-inject file or a stale pre-inject state.
  {
    const _planDbgFileSha = crypto.createHash('sha256').update(fs.readFileSync(historyPath, 'utf8')).digest('hex').slice(0, 16);
    appendAutoResumeLog(`runPlanning: historyFileSha256=${_planDbgFileSha} contextBytes=${context.length} contextHead=${JSON.stringify(context.slice(0, 200))} contextTail=${JSON.stringify(context.slice(-200))}`);
  }
  const historyRel = path.relative(ROOT, historyPath).replace(/\\/g, '/');
  // Inject history-self-lookup skill so the planning agent fetches prior-turn
  // context lazily via `Read` instead of receiving the parsed/truncated dump.
  const historySelfLookup = buildHistorySelfLookupBlock(historyPath);
  const ctxSection = buildContextSection(topicConfig.contextFiles, historyRel, repoRoot, repoRoot);
  // On re-run, use a planning system prompt WITHOUT the interrogate clause and add an explicit
  // "do not re-interrogate" action directive — prevents infinite clarifying-question loops.
  const systemPromptForRun = isRerun
    ? buildSystemPrompt('planning').replace(planningInterrogateClause, '')
    : systemPrompts.planning;
  const action = isRerun
    ? `The user has already answered prior clarifying questions in the conversation below. Produce the actionable implementation plan now. Do NOT emit a "## Clarifying Questions" section — make reasonable assumptions for any residual ambiguity and document them inline in the plan.${actionVerbositySuffix()}`
    : `Produce an implementation plan for the request below.${actionVerbositySuffix()}`;
  const payload = buildPayload(globalRules, historySelfLookup + systemPromptForRun + planReadOnlyClause + getSkillsSuffix(), action, context, ctxSection);
  const _snap = snapshotHistorySize();
  const { text, model, usage, costUsd, fallbackNote, effortNote, stopReason, continuations } = await runClaude(payload, { label: 'planning-agent', role: 'planning' });
  truncateHistoryIfAgentWrote(_snap, 'planning-agent');

  // Verify the planner included the ### Verified Citations section mandated by
  // planningCitationVerificationClause. Its absence means premises were not verified —
  // log a visible warning so the user can reject the plan before dispatching to coding.
  if (!/^###\s+Verified Citations/im.test(text)) {
    log('[planning-guard] WARNING: planning response is missing the "### Verified Citations" section. Premises may be unverified. Reject this plan or re-run planning before proceeding to coding.');
  }

  // Gap #1: diff check — warn if planning agent mutated files on a planMode=false provider.
  if (planSnapBefore !== null) {
    const planSnapAfter = spawnSync('git', ['diff', '--name-only'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
    if (planSnapAfter && planSnapAfter !== planSnapBefore) {
      const mutated = planSnapAfter.split('\n').filter(f => !planSnapBefore.split('\n').includes(f));
      if (mutated.length) {
        log(`[planning-guard] WARNING: planning agent mutated ${mutated.length} file(s) on a planMode=false provider — ${mutated.join(', ')}. Revert before running coding phase.`);
      }
    }
  }

  const footer = await buildUsageFooter(model, usage, costUsd, fallbackNote, effortNote, { stopReason, continuations });
  if (footer) process.stdout.write(footer + '\n');
  appendToFile(historyPath, `## ${ROLE_HEADER.planning}`, text + footer, { appendUserPromptSuffix: !noSuffix });
  // Pass the original user prompt (`context`) as the model-tier signal so verbose
  // plan output does not inflate the score into the heavy (Opus) tier.
  applyPlanningEffortAndModel(text, context);
  if (getMaxConcurrentAgents() > 1) {
    // Use the pure `nextPlannedSubtasksFromPlan` reducer so the assignment is UNCONDITIONAL.
    // A plan without `## Parallel Tasks` yields null, which overwrites any prior round's
    // value — structurally preventing the leak that the earlier `if (subs) plannedSubtasks = subs`
    // guard allowed. The reducer is unit-tested in tests/planning-subtasks-reset.test.js.
    plannedSubtasks = nextPlannedSubtasksFromPlan(text);
    if (plannedSubtasks) {
      log(`Planning agent identified ${plannedSubtasks.length} parallel subtask(s) — downstream phases will fan out.`);
      if (configUtils.cfgRead(topicConfig, config, 'validate-parallel-premises', false)) {
        const before = plannedSubtasks.length;
        plannedSubtasks = await validateParallelPremises(plannedSubtasks, text);
        log(`Premise validator approved ${plannedSubtasks.length} of ${before} subtask(s).`);
      }
    }
  }
}

async function validateParallelPremises(subtasks, planText) {
  log('--- Phase: premise-validator ---');
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const subtaskList = subtasks.map((t, i) => `### Subtask ${i + 1}\n${t}`).join('\n\n');
  const validatorPrompt =
`You are a premise validator. For each subtask below, check whether every factual claim (file path, function name, line number, diagnosis) is accurate against the actual source files referenced.

## Planning Output
${planText}

## Subtasks to Validate
${subtaskList}

For EACH subtask output exactly one line in this format (no other text):
SUBTASK_<N>: APPROVED
or
SUBTASK_<N>: REJECTED — <one-line reason>

where <N> is the 1-based subtask number. Output nothing else.`;
  const VALIDATOR_SYSTEM = 'You are a precise premise validator. Read the cited source files and for each subtask emit exactly one verdict line: SUBTASK_N: APPROVED or SUBTASK_N: REJECTED — reason. Output nothing else.';
  const payload = buildPayload(globalRules, VALIDATOR_SYSTEM, 'Validate the premises of each parallel subtask as instructed.', validatorPrompt, ctxSection);
  let validatorText = '';
  try {
    const result = await runClaude(payload, { silent: true, label: 'premise-validator', role: 'planning' });
    validatorText = result.text || '';
  } catch (err) {
    log(`Premise validator error — proceeding with all subtasks. ${err && err.message}`);
    return subtasks;
  }
  const approved = [];
  subtasks.forEach((task, i) => {
    const n = i + 1;
    const lineRe = new RegExp(`SUBTASK_${n}:\\s*(APPROVED|REJECTED)`, 'i');
    const m = validatorText.match(lineRe);
    if (!m || /APPROVED/i.test(m[1])) {
      approved.push(task);
    } else {
      const reasonMatch = validatorText.match(new RegExp(`SUBTASK_${n}:[^\\n]*REJECTED[^\\n]*—([^\\n]*)`, 'i'));
      const reason = reasonMatch ? reasonMatch[1].trim() : 'no reason given';
      log(`Premise validator rejected subtask ${n}: ${reason}`);
    }
  });
  return approved;
}

async function runCodingFromPlan(noSuffix = false) {
  setCurrentRole('coding');
  log('--- Phase: coding (from plan) ---');
  const plan = parseLatestSection(historyPath, ROLE_HEADER.planning);
  // Graceful degrade: a missing planning section (e.g. lost to a history
  // clobber/resume race) must NOT hard-fail the coding phase. Fall back to the
  // full conversation context so the coding agent still sees the original user
  // prompt + reply, mirroring runCoding(). Only die() if there is no user prompt
  // at all — nothing to code. The planIsOnlyQuestions branch (questions-only plan
  // body) reuses the same fallback, so one taskContent resolution covers
  // null-plan, questions-only-plan, and present-plan.
  if (!plan) log(`[WARN] No "## ${ROLE_HEADER.planning}" found in ${promptFileRel} — falling back to coding from conversation context.`);
  const planIsOnlyQuestions = !!plan && /^##+\s*Clarifying Questions/im.test(plan) && !/^[-*]\s/m.test(plan.replace(/^##+\s*Clarifying Questions[\s\S]*?(?=\n##+\s|$)/im, ''));
  let taskContent;
  if (!plan || planIsOnlyQuestions) {
    taskContent = parseConversationContext(historyPath) || plan;
    // Harden the no-content guard: trim before testing so an empty-but-truthy
    // string (e.g. whitespace-only conversation context) still trips die()
    // rather than feeding a blank task to the coding agent.
    if (!taskContent || !String(taskContent).trim()) die(`No "## ${ROLE_HEADER.planning}" or "## User Prompt" found in ${promptFileRel}. Run planning first.`);
  } else {
    taskContent = plan;
  }
  // Inject history-self-lookup skill for the coding-from-plan main turn.
  const historySelfLookup = buildHistorySelfLookupBlock(historyPath);
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const payload = buildPayload(globalRules, historySelfLookup + systemPrompts.coding + getSkillsSuffix(), `Execute the implementation plan below. Write a concise summary of what you did.${actionVerbositySuffix()}`, taskContent, ctxSection);
  const _snap = snapshotHistorySize();
  const { text, model, usage, costUsd, fallbackNote, effortNote, stopReason, continuations } = await runClaude(payload, { label: 'coding-agent', role: 'coding' });
  refreshHistoryPath();
  truncateHistoryIfAgentWrote(_snap, 'coding-agent');
  const footer = await buildUsageFooter(model, usage, costUsd, fallbackNote, effortNote, { stopReason, continuations });
  if (footer) process.stdout.write(footer + '\n');
  appendToFile(historyPath, `## ${ROLE_HEADER.coding}`, text + footer, { appendUserPromptSuffix: !noSuffix });
  recordTouchedFiles();
  validateTouchedJsonFilesOrThrow();
}

async function runCoding(noSuffix = false) {
  setCurrentRole('coding');
  log('--- Phase: coding ---');
  const context = parseConversationContext(historyPath);
  if (!context) die(`No "## User Prompt" found in ${promptFileRel}`);
  // Inject history-self-lookup skill for the coding main turn.
  const historySelfLookup = buildHistorySelfLookupBlock(historyPath);
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);

  // Plan-mode two-pass gate for providers without native plan-mode support.
  let taskContent = context;
  let provCaps;
  try { provCaps = getProvider().capabilities; } catch { provCaps = { planMode: true }; }
  if (!provCaps.planMode) {
    log(`[provider] planMode=false — running synthetic two-pass plan gate.`);
    const planPayload = buildPayload(
      globalRules,
      buildSystemPrompt('planning', { codingNoPlanning: false }) + getSkillsSuffix(),
      `Produce a concise implementation plan. Wrap the plan body in <plan>\\n...\\n</plan> tags. Do not write code yet.${actionVerbositySuffix()}`,
      context, ctxSection
    );
    const { text: planText } = await runClaude(planPayload, { label: 'planning-pass', role: 'planning' });
    const planMatch = planText.match(/<plan>([\s\S]*?)<\/plan>/i);
    const extractedPlan = planMatch ? planMatch[1].trim() : planText.trim();
    process.stdout.write('\n--- BEGIN PLAN ---\n' + extractedPlan + '\n--- END PLAN ---\n');
    process.stdout.write('[provider] Press Enter to execute this plan, or Ctrl-C to abort.\n');
    if (process.stdin.isTTY) {
      await new Promise(resolve => {
        const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        rl.once('line', () => { rl.close(); resolve(); });
      });
    }
    taskContent = extractedPlan;
  }

  const payload = buildPayload(
    globalRules,
    historySelfLookup + buildSystemPrompt('coding', { codingNoPlanning: true }) + getSkillsSuffix(),
    `Execute the task below. Write a concise technical summary of what you did.${actionVerbositySuffix()}`,
    taskContent,
    ctxSection
  );
  const _snap = snapshotHistorySize();
  const { text, model, usage, costUsd, fallbackNote, effortNote, stopReason, continuations } = await runClaude(payload, { label: 'coding-agent', role: 'coding' });
  refreshHistoryPath();
  truncateHistoryIfAgentWrote(_snap, 'coding-agent');
  const footer = await buildUsageFooter(model, usage, costUsd, fallbackNote, effortNote, { stopReason, continuations });
  if (footer) process.stdout.write(footer + '\n');
  appendToFile(historyPath, `## ${ROLE_HEADER.coding}`, text + footer, { appendUserPromptSuffix: !noSuffix });
  recordTouchedFiles();
  validateTouchedJsonFilesOrThrow();
}

async function runAssessment(noSuffix = false, { parallelTaskCount = 0 } = {}) {
  setCurrentRole('assessment');
  log('--- Phase: assessment ---');
  const context = parseConversationContext(historyPath) ||
    "Review the latest git diff and the coding agent's recent response for issues.";
  // Inject history-self-lookup skill for the assessment main turn.
  const historySelfLookup = buildHistorySelfLookupBlock(historyPath);
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const verbosity = topicConfig ? (topicConfig.outputVerbosity ?? 5) : 5;
  const diffLimit = verbosity >= 8 ? 16000 : verbosity >= 5 ? 8000 : 4000;
  const unstagedDiff = spawnSync('git', ['diff'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const diffSection = unstagedDiff
    ? `\n\n## Unstaged Git Diff\n\n\`\`\`diff\n${unstagedDiff.slice(0, diffLimit)}\n\`\`\``
    : '';
  const parallelHeader = buildParallelCodingBriefHeader(parallelTaskCount);
  const payload = buildPayload(
    globalRules,
    historySelfLookup + systemPrompts.assessment + getSkillsSuffix(),
    `Review recent code changes against the prompt below. Log all findings concisely.${actionVerbositySuffix()}`,
    parallelHeader + context + diffSection,
    ctxSection
  );
  const _snap = snapshotHistorySize();
  const { text, model, usage, costUsd, fallbackNote, effortNote, stopReason, continuations } = await runClaude(payload, { label: 'assessment-agent', role: 'assessment' });
  truncateHistoryIfAgentWrote(_snap, 'assessment-agent');
  const footer = await buildUsageFooter(model, usage, costUsd, fallbackNote, effortNote, { stopReason, continuations });
  if (footer) process.stdout.write(footer + '\n');
  appendToFile(historyPath, `## ${ROLE_HEADER.assessment}`, text + footer, { appendUserPromptSuffix: !noSuffix });
}

// runAsk: read-only Q&A phase. Answers the user's question using codebase context.
// No git diff injection — ask is not a code-review phase.
async function runAsk(noSuffix = false) {
  setCurrentRole('ask');
  log('--- Phase: ask ---');
  const context = parseConversationContext(historyPath) ||
    "Answer the user's question using the codebase context provided.";
  const historySelfLookup = buildHistorySelfLookupBlock(historyPath);
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const payload = buildPayload(
    globalRules,
    historySelfLookup + systemPrompts.ask + getSkillsSuffix(),
    `Answer the question below thoroughly and accurately using codebase context. Do not modify any files.${actionVerbositySuffix()}`,
    context,
    ctxSection
  );
  const _snap = snapshotHistorySize();
  const { text, model, usage, costUsd, fallbackNote, effortNote, stopReason, continuations } = await runClaude(payload, { label: 'ask-agent', role: 'ask' });
  truncateHistoryIfAgentWrote(_snap, 'ask-agent');
  const footer = await buildUsageFooter(model, usage, costUsd, fallbackNote, effortNote, { stopReason, continuations });
  if (footer) process.stdout.write(footer + '\n');
  appendToFile(historyPath, `## ${ROLE_HEADER.ask}`, text + footer, { appendUserPromptSuffix: !noSuffix });
}

async function runFleet({ kind, subtasks, taskFn }) {
  const fleetHeartbeatMs = config.prespawnHeartbeatMs || 5000;
  const labels = subtasks.map((_, i) => `task-${i + 1}`);
  let liveCount = subtasks.length;
  const hb = setInterval(() => {
    if (liveCount <= 0) return;
    const topicNames = readActiveTopics();
    const topicList = topicNames.length > 0 ? topicNames.join(', ') : topic;
    process.stdout.write(`\n[${liveCount} ${kind}-agents] working… topics: [${topicList}]\n`);
  }, fleetHeartbeatMs);
  if (hb.unref) hb.unref();
  try {
    return await Promise.all(subtasks.map(async (sub, i) => {
      try {
        const r = await taskFn(sub, i, labels[i]);
        return { ...r, label: labels[i] };
      } catch (err) {
        // Mutate+rethrow the ORIGINAL error (via _prefixFleetError) rather than
        // wrapping in `new Error(...)`, which would drop typed token props
        // (tokenReset/tokensExhausted/monthlyCapHit/cliOutput) and break the
        // runPipeline countdown / provider-fallback for parallel fleets.
        throw _prefixFleetError(err, labels[i]);
      } finally {
        liveCount--;
      }
    }));
  } finally {
    clearInterval(hb);
  }
}

// ── Coding-parallel bullet-format enforcement ────────────────────────────────
// Pure detector for the mandated markdown-bullet output contract. Some fanned
// coding agents ignore the prompt and emit one giant prose paragraph; this lets
// the results loop deterministically catch that before appending to history.
// Strips fenced code, markdown headers, and the trailing usage footer (exempt),
// then flags any TOP-LEVEL line that is prose (not `- `) or an over-verbose
// (>600 char) bullet. Indented continuations and `#` headers are allowed.
function isBulletFormatted(text) {
  if (!text || !text.trim()) return true;
  // When caveman terseness is active, the prompt's verbosity complaint is also a
  // hard requirement — a structurally-valid all-bullets response can still be far
  // too verbose. Apply a tighter per-bullet length cap so wordy-but-bulleted
  // output is flagged for reformatting too, not just non-bulleted prose. Cap stays
  // lenient (600) when caveman is off so normal responses are not over-triggered.
  const cavemanActive = !!(cavemanClause && cavemanClause.trim());
  const maxBulletLen = cavemanActive ? 280 : 600;
  // Remove fenced code blocks and any trailing "*Model: …*" usage footer first —
  // both are exempt from the bullet rule.
  let s = text.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/\n?\*Model:[\s\S]*$/i, '');
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;          // blank line
    if (/^\s/.test(raw)) continue;       // indented continuation
    if (/^#{1,6}\s/.test(line)) continue; // markdown header
    if (/^- /.test(line)) {              // top-level bullet
      if (line.length > maxBulletLen) return false; // over-verbose run-on bullet
      continue;
    }
    return false;                        // top-level prose line
  }
  return true;
}

// If an agent's response already satisfies the bullet contract, return it
// unchanged (zero token spend). Otherwise issue ONE reformat call (retried once)
// that preserves technical content verbatim. If both attempts fail the detector,
// keep the ORIGINAL text and warn. Footer/usage stay attributed to the original
// coding agent because only `r.text` is replaced by the caller.
async function enforceBulletFormat(text, label) {
  if (isBulletFormatted(text)) return text;
  const fmtSystem =
    'You are a formatter. Reformat the message into the mandated markdown bullet list. Preserve ALL technical content verbatim — add nothing, drop nothing, invent no facts. Output only the reformatted message.' +
    outputFormattingMandateClause + (cavemanClause || '');
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload = buildPayload(globalRules, fmtSystem, 'Reformat the message below.', text, '');
    const r = await runClaude(payload, { silent: true, label, role: 'coding' });
    if (r && r.text && isBulletFormatted(r.text)) return r.text;
  }
  log(`[WARN] ${label} output not bullet-formatted after 1 reformat retry — kept original`);
  return text;
}

async function runCodingParallel(subtasks, noSuffix = false, { noPlanning = false } = {}) {
  const cap = getMaxConcurrentAgents();
  const tasks = subtasks.slice(0, Math.min(subtasks.length, cap));
  log(`--- Phase: coding (parallel × ${tasks.length}) ---`);
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const fullContext = parseConversationContext(historyPath) || '';
  const codingSystemPrompt = buildSystemPrompt('coding', { codingNoPlanning: noPlanning }) + getSkillsSuffix();
  const snapBefore = snapshotHistorySize();
  const results = await runFleet({
    kind: 'coding',
    subtasks: tasks,
    taskFn: async (task, i, label) => {
      // Append caveman + output-formatting clauses as the LAST content of the
      // per-agent payload. Both consts carry their own leading \n\n; cavemanClause
      // is '' when disabled (no-op). Recency keeps fanned coding output bulleted/terse.
      const subPayload =
`You are Coding Agent ${i + 1} of ${tasks.length}. Other agents run in parallel — only changes you make are yours. Focus ONLY on the subtask assigned to you below. Do not duplicate work that belongs to a sibling subtask.

## Premise Check (Mandatory)
Before writing any code, re-verify every factual claim in your subtask against the actual source files (read the cited file and line range). If the cited evidence does not exist, has already been fixed, or does not support the diagnosis, do NOT write code. Instead emit a section headed exactly:

## Premise Rejected
…with the specific counter-evidence (file path, line number, what you actually found). Stop there — do not proceed to implementation.

Only proceed to implementation if every cited premise is confirmed by the source.

## Your Subtask
${task}

## Full Original Prompt Context (for reference)
${fullContext}${cavemanClause}${outputFormattingMandateClause}`;
      const payload = buildPayload(
        globalRules,
        codingSystemPrompt,
        `Execute ONLY your assigned subtask. Write a concise technical summary of what you did.${actionVerbositySuffix()}`,
        subPayload,
        ctxSection
      );
      return runClaude(payload, { silent: true, label, role: 'coding' });
    },
  });
  refreshHistoryPath();
  truncateHistoryIfAgentWrote(snapBefore, 'coding-parallel');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (/^##\s+Premise Rejected/im.test(r.text)) {
      process.stderr.write(`\n[WARN] Coding Agent ${i + 1} of ${tasks.length} emitted ## Premise Rejected — subtask was NOT implemented. Review history and re-plan.\n`);
    }
    // Enforce the mandated bullet contract on the agent's prose AFTER the
    // Premise-Rejected check (which must run on the original text) but BEFORE
    // building the footer/appending, so non-compliant fanned output is reformatted
    // deterministically instead of leaking a run-on paragraph into history.
    r.text = await enforceBulletFormat(r.text, roleHeaderFor('coding', i + 1, tasks.length));
    const footer = await buildUsageFooter(r.model, r.usage, r.costUsd, r.fallbackNote, r.effortNote, { stopReason: r.stopReason, continuations: r.continuations });
    appendToFile(historyPath, `## ${roleHeaderFor('coding', i + 1, tasks.length)}`, r.text + footer, { appendUserPromptSuffix: false });
  }
  if (!noSuffix) appendUserPromptSuffixToFile(historyPath);
  recordTouchedFiles();
  validateTouchedJsonFilesOrThrow();
  return tasks;
}

async function runAssessmentParallel(subtasks, noSuffix = false) {
  const cap = getMaxConcurrentAgents();
  const tasks = subtasks.slice(0, Math.min(subtasks.length, cap));
  log(`--- Phase: assessment (parallel × ${tasks.length}) ---`);
  const verbosity = topicConfig ? (topicConfig.outputVerbosity ?? 5) : 5;
  const diffLimit = verbosity >= 8 ? 16000 : verbosity >= 5 ? 8000 : 4000;
  const unstagedDiff = spawnSync('git', ['diff'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const diffSection = unstagedDiff
    ? `\n\n## Unstaged Git Diff (combined across all parallel coding agents)\n\n\`\`\`diff\n${unstagedDiff.slice(0, diffLimit)}\n\`\`\``
    : '';
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const historyContent = fs.readFileSync(historyPath, 'utf8');
  const codingSummaries = tasks.map((_, i) => {
    const n = i + 1;
    // Match new format "Coding Agent N Response" or legacy "Coding Agent Response (task-N)".
    const re = new RegExp(`^##+\\s*Coding Agent (?:${n} Response|Response \\(task-${n}\\))\\s*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`, 'im');
    const m = historyContent.match(re);
    return m ? m[1].trim() : '';
  });
  const siblingSummariesBlock = codingSummaries
    .map((s, i) => `### task-${i + 1} summary\n${s || '(no summary captured)'}`)
    .join('\n\n');
  const parallelBrief =
`Parallel run: ${tasks.length} coding agents touched the working tree concurrently. Assess ONLY changes relevant to YOUR task; ignore unrelated diffs from siblings. Match by file/intent, not by \`git diff\` ownership. Use the sibling coding-agent summaries below to attribute hunks correctly.

## Sibling Coding-Agent Summaries (all parallel tasks)
${siblingSummariesBlock}`;
  const snapBefore = snapshotHistorySize();
  const results = await runFleet({
    kind: 'assessment',
    subtasks: tasks,
    taskFn: async (task, i, label) => {
      // Append caveman + output-formatting clauses as the LAST content of the
      // per-agent assessment payload — same buried-mandate fix as runCodingParallel.
      // Both consts self-prefix \n\n; cavemanClause is '' when disabled (no-op).
      // Recency keeps fanned assessment output bulleted/terse instead of run-on prose.
      const body = `${parallelBrief}\n\n## Subtask Under Review (agent ${i + 1} of ${tasks.length})\n\n${task}${diffSection}${cavemanClause}${outputFormattingMandateClause}`;
      const payload = buildPayload(
        globalRules,
        systemPrompts.assessment + getSkillsSuffix(),
        `Review only the subtask below — sibling subtasks are being assessed by other parallel assessment agents.${actionVerbositySuffix()}`,
        body,
        ctxSection
      );
      return runClaude(payload, { silent: true, label, role: 'assessment' });
    },
  });
  truncateHistoryIfAgentWrote(snapBefore, 'assessment-parallel');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // Enforce the mandated bullet contract on fanned assessment prose before the
    // footer is built/appended — same run-on-paragraph leak existed on this sibling
    // path as in runCodingParallel. Footer/usage stay attributed to the original
    // assessment agent because only r.text is replaced.
    r.text = await enforceBulletFormat(r.text, roleHeaderFor('assessment', i + 1, tasks.length));
    const footer = await buildUsageFooter(r.model, r.usage, r.costUsd, r.fallbackNote, r.effortNote, { stopReason: r.stopReason, continuations: r.continuations });
    appendToFile(historyPath, `## ${roleHeaderFor('assessment', i + 1, tasks.length)}`, r.text + footer, { appendUserPromptSuffix: false });
  }
  if (!noSuffix) appendUserPromptSuffixToFile(historyPath);
  return tasks;
}

async function runCodingAssessmentParallel(subtasks, noSuffix = false) {
  const cap = getMaxConcurrentAgents();
  const tasks = subtasks.slice(0, Math.min(subtasks.length, cap));
  log(`--- Phase: fix (parallel × ${tasks.length}) ---`);
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const historyContent = fs.readFileSync(historyPath, 'utf8');
  const taskFeedback = tasks.map((_, i) => {
    const n = i + 1;
    const re = new RegExp(`^##+\\s*Assessment Agent (?:${n} Response|Response \\(task-${n}\\))\\s*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`, 'im');
    const m = historyContent.match(re);
    return m ? m[1].trim() : '';
  });
  const codingSummaries = tasks.map((_, i) => {
    const n = i + 1;
    const re = new RegExp(`^##+\\s*Coding Agent (?:${n} Response|Response \\(task-${n}\\))\\s*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`, 'im');
    const m = historyContent.match(re);
    return m ? m[1].trim() : '';
  });
  const siblingSummariesBlock = codingSummaries
    .map((s, i) => `### task-${i + 1} prior coding summary\n${s || '(no summary captured)'}`)
    .join('\n\n');
  const snapBefore = snapshotHistorySize();
  const results = await runFleet({
    kind: 'coding',
    subtasks: tasks,
    taskFn: async (task, i, label) => {
      const body =
`Parallel run: ${tasks.length} fix agents are applying remediation concurrently. Re-fix ONLY changes relevant to YOUR task — match by file/intent, not by \`git diff\` ownership; do not touch unrelated diffs from siblings. The assessment feedback below pertains ONLY to your subtask. Use the sibling coding-agent summaries to attribute hunks correctly.

## Sibling Coding-Agent Summaries (all parallel tasks)
${siblingSummariesBlock}

## Your Subtask
${task}

## Assessment Feedback for Your Subtask
${taskFeedback[i] || '(no assessment feedback for this subtask)'}`;
      const payload = buildPayload(
        globalRules,
        systemPrompts.coding + getSkillsSuffix(),
        `Fix the issues identified for your subtask and summarize what was corrected.${actionVerbositySuffix()}`,
        body,
        ctxSection
      );
      return runClaude(payload, { silent: true, label, role: 'coding' });
    },
  });
  refreshHistoryPath();
  truncateHistoryIfAgentWrote(snapBefore, 'coding-remediation-parallel');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // Enforce the mandated bullet contract on fanned fix/remediation prose before
    // the footer is built/appended — closes the same run-on-paragraph leak on this
    // sibling path. Only r.text is replaced, so footer/usage stay attributed to the
    // original fix agent.
    r.text = await enforceBulletFormat(r.text, roleHeaderFor('fix', i + 1, tasks.length));
    const footer = await buildUsageFooter(r.model, r.usage, r.costUsd, r.fallbackNote, r.effortNote, { stopReason: r.stopReason, continuations: r.continuations });
    appendToFile(historyPath, `## ${roleHeaderFor('fix', i + 1, tasks.length)}`, r.text + footer, { appendUserPromptSuffix: false });
  }
  if (!noSuffix) appendUserPromptSuffixToFile(historyPath);
  recordTouchedFiles();
  validateTouchedJsonFilesOrThrow();
}

async function runCodingAssessment(noSuffix = false, { parallelTaskCount = 0 } = {}) {
  log('--- Phase: fix (remediation) ---');
  const feedback = parseLatestSection(historyPath, ROLE_HEADER.assessment);
  if (!feedback) die(`No "## ${ROLE_HEADER.assessment}" found in ${promptFileRel}. Run assessment first.`);
  // Inject history-self-lookup skill for the fix/remediation main turn.
  const historySelfLookup = buildHistorySelfLookupBlock(historyPath);
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const parallelHeader = buildParallelCodingBriefHeader(parallelTaskCount);
  const payload = buildPayload(
    globalRules,
    historySelfLookup + systemPrompts.coding + getSkillsSuffix(),
    `The QA assessment below identified issues. Fix them in the codebase and summarize what was corrected.${actionVerbositySuffix()}`,
    parallelHeader + feedback,
    ctxSection
  );
  const _snap = snapshotHistorySize();
  const { text, model, usage, costUsd, fallbackNote, effortNote, stopReason, continuations } = await runClaude(payload, { label: 'coding-agent', role: 'coding' });
  refreshHistoryPath();
  truncateHistoryIfAgentWrote(_snap, 'coding-agent (remediation)');
  const footer = await buildUsageFooter(model, usage, costUsd, fallbackNote, effortNote, { stopReason, continuations });
  if (footer) process.stdout.write(footer + '\n');
  appendToFile(historyPath, `## ${ROLE_HEADER.fix}`, text + footer, { appendUserPromptSuffix: !noSuffix });
  recordTouchedFiles();
  validateTouchedJsonFilesOrThrow();
}

// ── Notification sound + reminder loop ───────────────────────────────────────

let _beepInFlight = false;
// =========================================================================
// Clarifying-question interaction: detect "## Clarifying Questions" in the
// latest response, prompt user (CLI or IPC broker), parse multi-line reply,
// auto-answer where signature matches a prior identical block.
// =========================================================================
// Resolve a `*-sound-file` config value to an absolute `.wav` path. Bare
// filenames (no separator) resolve under the Windows media dir so the named
// system sounds (`tada.wav`, `Windows Notify Calendar.wav`, …) work without an
// absolute path; absolute paths pass through; other relative paths resolve from
// the harness root. Added so the per-event sound keys carry real `.wav` files
// (user request) rather than synthesized-tone specs.
function _resolveWavPath(val) {
  if (path.isAbsolute(val)) return val;
  if (!/[\\/]/.test(val)) return path.join('C:\\Windows\\Media', val);
  return path.resolve(__dirname, '..', val);
}

// Shared sound-playback helper. Resolves the per-event `*-sound-file` config key
// (falling back to `defaultWav`, the named system `.wav`) and plays it via
// PowerShell `Media.SoundPlayer`. Beep-spec/synthesized-tone support removed:
// every sound is now a `.wav` file and a missing/locked file fails SILENTLY (no
// beep fallback) per the user request to drop all synthesized tones. Master
// `play-notification-sound` gate + `_beepInFlight` latch semantics unchanged.
function _playSoundFile(configKey, defaultWav) {
  // Mute all five notification events for spawned child agents so only the
  // top-level orchestrator emits sound. Two child kinds are suppressed:
  //   1. parallel-QUEUE children — makeSpawnRunner sets AGENT_ORCH_TOPIC_DIR_OVERRIDE.
  //   2. broker children — multi-topic `hrun 1-caf 2-f` runs each topic as a
  //      concurrent child (parallel-broker.spawnChild); those carry the SAME env
  //      and lack the override, so without this flag each child independently
  //      fired its own queue-fetch/completion/clarifying/error chimes while all
  //      were busy → the "constant beeps with stops and starts" regression. The
  //      broker process owns the single clarifying chime; brokered children stay
  //      silent. Parent (neither var set) remains sole emitter.
  if (process.env.AGENT_ORCH_TOPIC_DIR_OVERRIDE || process.env.AGENT_ORCH_BROKERED_CHILD) return;
  // Test/e2e suppression: stubbed harness dispatches use a `__e2e_stub*` topic
  // and spin up many short-lived processes, each hitting the post-drain
  // pending===0 gate and firing tada.wav — the repeated burst proven in
  // .state/auto-resume.log:591-639. Real topics never carry this prefix, so
  // mute all five events for stub dispatches entirely.
  if (typeof topic === 'string' && topic.startsWith('__e2e_stub')) return;
  const enabled = configUtils.cfgRead(topicConfig, config, 'play-notification-sound', true);
  if (enabled === false) return;
  if (_beepInFlight) return;
  try {
    if (process.platform === 'win32') {
      // Config key (or its `.wav` default) drives playback; empty disables.
      const cfgVal = String(configUtils.cfgRead(topicConfig, config, configKey, defaultWav) || '').trim();
      if (!cfgVal) return;
      // Treat the value as a `.wav` file path; on spawn error clear the latch
      // and stay silent (no synthesized-beep fallback).
      _beepInFlight = true;
      const wav = _resolveWavPath(cfgVal).replace(/'/g, "''");
      const psCmd = `(New-Object Media.SoundPlayer '${wav}').PlaySync()`;
      const ps = spawn('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'ignore', detached: false, windowsHide: true });
      ps.on('exit', () => { _beepInFlight = false; });
      ps.on('error', () => { _beepInFlight = false; });
    } else {
      // No synthesized BEL fallback off win32 — honor "no beeps at any stage";
      // non-win32 hosts stay silent rather than emitting `\x07`.
      return;
    }
  } catch { _beepInFlight = false; }
}

// Event 1 — user response needed (clarifying questions). Plays the `.wav` at
// `clarifying-sound-file`. Gated: when `auto-answer-clarifying-questions-and-submit`
// is on, the harness answers and submits without pausing for the user, so the
// "your input is needed" tone would be spurious — early-return to suppress it.
function playClarifyingSound() {
  if (configUtils.cfgRead(topicConfig, config, 'auto-answer-clarifying-questions-and-submit', false)) return;
  _playSoundFile('clarifying-sound-file', 'Alarm01.wav');
}

// Event 2 — new prompt pulled from `prompt-queue.md`.
function playQueueFetchSound() {
  _playSoundFile('queue-fetch-sound-file', 'notify.wav');
}

// Event 3 — pipeline complete and session ending. The sole call site (:4776)
// already fires only once per dispatch, after the in-process queue drain returns
// with queueLength===0 — so no extra once-per-process latch is needed here. A
// latch was removed because it never reset and would permanently silence a
// second legitimate completion in any long-lived/re-dispatch process.
function playCompletionSound() {
  _playSoundFile('completion-sound-file', 'tada.wav');
}

// Event 4 — token limit hit, awaiting auto-resume.
function playTokenLimitSound() {
  _playSoundFile('token-limit-sound-file', 'Windows Notify Messaging.wav');
}

// Event 5 — error forced session to stop.
function playErrorSound() {
  _playSoundFile('error-sound-file', 'Windows Critical Stop.wav');
}

// Play the clarifying-question tone when the pipeline pauses for a reply. The
// repeating reminder loop was removed (single cue only); the master
// `play-notification-sound` gate + auto-submit gate live inside the wrappers.
function startClarifyingQuestionWait() {
  playClarifyingSound();
}

// ── Clarifying-questions handler ──────────────────────────────────────────────

function lastAgentResponseContainsClarifyingQuestions() {
  const content = fs.readFileSync(historyPath, 'utf8');
  const re = new RegExp(`^##\\s+${ANY_RESPONSE_HEADER}[^\\n]*$`, 'gim');
  let lastIdx = -1;
  let m;
  while ((m = re.exec(content)) !== null) lastIdx = m.index + m[0].length;
  if (lastIdx < 0) return null;
  const tail = content.slice(lastIdx);
  const nextHeader = tail.search(/^##\s+(?!Clarifying Questions\b)/m);
  const body = nextHeader >= 0 ? tail.slice(0, nextHeader) : tail;
  // NOTE: no `m` flag here so `$` means end-of-string, NOT end-of-line.
  // With `m` flag, non-greedy `[\s\S]*?` would stop at the first line-end `$`
  // (after Q1), causing all subsequent questions to be silently dropped.
  // `(?:^|\r?\n)` replaces the multiline-mode `^` anchor so we still match
  // the header anywhere in the body string. Also avoid `\s*` before the
  // terminal `\n` — that consumed the blank line separator, shifting the
  // capture start and amplifying the early-stop.
  const qm = body.match(/(?:^|\r?\n)##+[ \t]*Clarifying Questions[ \t]*\r?\n([\s\S]*?)(?=\r?\n##+\s|$)/i);
  const _hasNumberedCandidate = /^\s*\d+\.\s+.*\?\s*$/m.test(body);
  const _shouldLogSlice = !!qm || _hasNumberedCandidate || process.env.AUTO_ANSWER_CLARIFYING_QUESTIONS_DEBUG_VERBOSE === '1';
  if (_shouldLogSlice) {
    try {
      appendAutoAnswerClarifyingQuestionsDebug({
        topic: typeof topic === 'string' ? topic : '',
        label: 'lastAgentResponseContainsClarifyingQuestions-slice',
        expectedCount: 0,
        answeredIndices: [],
        note: `tailLen=${tail.length}; bodyLen=${body.length}; nextHeader=${nextHeader}; qmMatched=${!!qm}`,
        text: `=== TAIL ===\n${tail}\n=== BODY ===\n${body}\n=== QM[1] ===\n${qm ? qm[1] : '(no match)'}`
      });
    } catch {}
  }
  if (qm) return qm[1].trim();
  // Fallback (Item 1c): agent emitted a numbered question list but skipped the
  // `## Clarifying Questions` header. Per plan: require ≥2 numbered question lines
  // (each with trailing `?`) AND no `## Code` header preceding the list — keeps
  // false-positive guard tight. Require: ≥1 question line with trailing `?`,
  // first match must be `1.` (not arbitrary N), block size > 50 chars, no `## Code` header.
  const numberedRe = /^\s*\d+\.\s+.*$/gm;
  const numberedMatches = body.match(numberedRe) || [];
  const questionLines = numberedMatches.filter(l => /\?\s*$/.test(l));
  const hasCodeHeader = /^##+\s*Code\b/im.test(body);
  const firstIsOne = /^\s*1\.\s+/m.test(body);
  if (questionLines.length >= 1 && !hasCodeHeader && firstIsOne && body.trim().length > 50) {
    const firstNumIdx = body.search(/^\s*1\.\s+/m);
    if (firstNumIdx >= 0) {
      const before = body.slice(0, firstNumIdx).trimEnd();
      const synthetic = body.slice(firstNumIdx).trim();
      try {
        const fullBefore = content.slice(0, lastIdx) + (before ? before + '\n' : '');
        const after = content.slice(lastIdx + (nextHeader >= 0 ? nextHeader : tail.length));
        const injected = fullBefore + '\n\n## Clarifying Questions\n\n' + synthetic + '\n' + after;
        fs.writeFileSync(historyPath, injected, 'utf8');
        log('Detected numbered question list without `## Clarifying Questions` header — injected synthetic header.');
      } catch (e) { log(`Synthetic header injection failed: ${e.message}`); }
      return synthetic;
    }
  }
  return null;
}

function readUserReplyFromHistory() {
  try {
    const content = fs.readFileSync(historyPath, 'utf8');
    const cqRe = /^##+\s*Clarifying Questions\b/gim;
    let lastCq = -1;
    let m;
    while ((m = cqRe.exec(content)) !== null) lastCq = m.index;
    if (lastCq < 0) return null;
    const tail = content.slice(lastCq);
    // Item 2: parser accepts BOTH `## User Reply to Questions` (manual or auto-pause)
    // and `## Auto Reply to Clarifying Questions` (auto-answer-clarifying-questions-and-submit path).
    // FIX: 'i' flag only — no 'm', so '$' = end-of-string not end-of-line, preventing
    // lazy [\s\S]*? from terminating at first blank-line boundary inside the reply block.
    // '^' removed so match works anywhere in tail without requiring multiline anchoring.
    const rm = tail.match(/##\s*(?:User Reply to Questions|Auto Reply to Clarifying Questions)\s*\n([\s\S]*?)(?=\n##+\s|$)/i);
    if (!rm) return null;
    const body = rm[1].trim();
    return body || null;
  } catch {
    return null;
  }
}

// IPC mode (parallel broker parent): instead of opening readline on stdin,
// emit a `{type:'question'}` message and await the parent's `{type:'answer'}`.
// Non-IPC mode keeps the original readline-driven CLI UX unchanged.
let _currentRole = null;
function setCurrentRole(role) { _currentRole = role; }
function promptForUserReply(pendingQuestionsText) {
  if (process.send && process.connected) {
    return new Promise(resolve => {
      const cleanup = () => {
        process.removeListener('message', onMessage);
        process.removeListener('disconnect', onDisconnect);
      };
      const onMessage = (m) => {
        if (m && m.type === 'answer') {
          cleanup();
          resolve(typeof m.text === 'string' ? m.text : '');
        }
      };
      const onDisconnect = () => {
        cleanup();
        log('IPC channel disconnected while awaiting answer — exiting child.');
        process.exit(1);
      };
      process.on('message', onMessage);
      process.on('disconnect', onDisconnect);
      try {
        process.send({
          type: 'question',
          topic: typeof topic === 'string' ? topic : '',
          role: _currentRole || 'unknown',
          questionsText: pendingQuestionsText || '',
        });
      } catch (e) {
        cleanup();
        // stdin is 'ignore' under broker spawn — readline fallback would hang. Resolve empty.
        log(`IPC send failed (${e.message}) — no stdin available under broker, resolving empty reply.`);
        resolve('');
      }
    });
  }
  return _readlinePromptForUserReply();
}

function _readlinePromptForUserReply() {
  return new Promise(resolve => {
    process.stdout.write(
`\n ─────────────────────────────────────────────────────────
 CLARIFYING QUESTIONS detected — pipeline paused.
 Option A: edit ${path.relative(ROOT, historyPath)} under "## User Reply to Questions", save, then type :submit (or :s) here.
 Option B: type your multi-line answer below.
 _(type :submit (or :s) on its own line to submit. Pressing ENTER twice on consecutive blank lines also submits.)_
 ─────────────────────────────────────────────────────────
> `);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const bufferLines = [];
    let prevNonBlank = false;
    let blankRun = 0;
    const finish = () => {
      rl.removeAllListeners('line');
      rl.close();
      // Trim trailing blank lines from captured buffer.
      while (bufferLines.length && !bufferLines[bufferLines.length - 1].trim()) bufferLines.pop();
      // Force-flush any unsaved VS Code editor buffers BEFORE re-reading prompt file.
      // `force: true` -> bypass per-run throttle (user just typed; may have also edited file).
      saveAllVsCodeBuffers({ force: true });
      // Item 4: file-on-disk wins. Always re-read disk FIRST after saving buffers;
      // if disk has a non-empty reply block, use it verbatim and discard the CLI buffer.
      // Only fall back to the CLI-typed buffer when disk reply is empty/missing.
      const fileReply = readUserReplyFromHistory();
      if (fileReply && fileReply.trim()) {
        if (bufferLines.length) {
          process.stdout.write('(disk reply present — using "## User Reply to Questions" block from prompt file; CLI buffer discarded)\n');
        } else {
          process.stdout.write('(using "## User Reply to Questions" block from prompt file)\n');
        }
        resolve(fileReply);
        return;
      }
      const buf = bufferLines.join('\n');
      if (!buf.trim()) {
        process.stdout.write('(empty reply — re-prompting; type your answer then submit with :submit (or two blank lines))\n> ');
        _readlinePromptForUserReply().then(resolve);
        return;
      }
      resolve(buf);
    };
    rl.on('line', (line) => {
      const trimmed = line.trim();
      // Item 2: explicit submit sentinels — `:submit` or short `:s`.
      if (trimmed === ':submit' || trimmed === ':s') { finish(); return; }
      if (trimmed === ':queue-next' || trimmed === ':qn') {
        log('Manual queue advance requested — dispatching head block.');
        dequeueAndTriggerNext({ manualSubmit: true }).catch(e => log(`:queue-next failed: ${e.message}`));
        return;
      }
      if (trimmed === ':queue-regen' || trimmed === ':qregen') {
        try {
          const r = promptQueue.regenerateQueueFile(topicDirPath());
          log(`prompt-queue: regenerated (wiped ${r.priorCount} prior user block(s); seed excluded) -> ${r.file}`);
        } catch (e) { log(`:queue-regen failed: ${e.message}`); }
        return;
      }
      if (trimmed === '') {
        // Submit on TWO consecutive blank lines (historical Enter-twice) only when
        // some non-blank content has already been buffered. Single blank Enter alone
        // does NOT submit — prevents accidental early-submit when user pauses typing.
        blankRun++;
        if (blankRun >= 2 && prevNonBlank) { finish(); return; }
        bufferLines.push(line);
      } else {
        bufferLines.push(line);
        prevNonBlank = true;
        blankRun = 0;
      }
    });
  });
}

function extractNumberedQuestions(questionsText) {
  // Split into numbered items: lines starting with "N." capture until next "N." or end.
  const out = [];
  const hits = [];
  const re = /^\s*(\d+)\.\s+([\s\S]*?)(?=^\s*\d+\.\s+|$(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(questionsText)) !== null) {
    const n = Number(m[1]);
    const text = m[2].trim();
    out.push({ n, text });
    hits.push({ n, text });
  }
  try {
    for (const h of hits) {
      appendAutoAnswerClarifyingQuestionsDebug({
        topic: typeof topic === 'string' ? topic : '',
        label: 'extractNumberedQuestions-hit',
        expectedCount: hits.length,
        answeredIndices: [h.n],
        note: `raw regex hit n=${h.n}`,
        text: h.text
      });
    }
    appendAutoAnswerClarifyingQuestionsDebug({
      topic: typeof topic === 'string' ? topic : '',
      label: 'extractNumberedQuestions-raw',
      expectedCount: hits.length,
      answeredIndices: hits.map(h => h.n),
      note: `full raw questionsText (untruncated) — hits=${hits.length}`,
      text: questionsText || ''
    });
  } catch {}
  return out;
}

function autoAnswerClarifyingQuestionsSigPath(topicName) {
  return path.join(STATE_DIR, `last-auto-answer-clarifying-questions-${topicName}.json`);
}
function hashBody(s) {
  // Normalize whitespace so `writeAutoAnswerClarifyingQuestionsSig(rawBody)` matches `hashBody(trimmedExistingReply)` later.
  const norm = (s || '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}
function writeAutoAnswerClarifyingQuestionsSig(topicName, body) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(autoAnswerClarifyingQuestionsSigPath(topicName), JSON.stringify({ hash: hashBody(body) }) + '\n', 'utf8');
  } catch {}
}
function readAutoAnswerClarifyingQuestionsSig(topicName) {
  try { return JSON.parse(fs.readFileSync(autoAnswerClarifyingQuestionsSigPath(topicName), 'utf8')).hash || null; }
  catch { return null; }
}

const AUTO_REPLY_HEADER = 'Auto Reply to Clarifying Questions';
const USER_REPLY_HEADER = 'User Reply to Questions';

async function autoAnswerClarifyingQuestionsClarifyingQuestions(questionsText, { headerName = USER_REPLY_HEADER } = {}) {
  log('Auto-answer-clarifying-questionsing clarifying questions via assessment agent...');
  const ctxSection = buildContextSection(topicConfig.contextFiles, null, repoRoot, repoRoot);
  const fullContext = parseConversationContext(historyPath) || '';
  const numbered = extractNumberedQuestions(questionsText);
  const expectedCount = numbered.length;
  appendAutoAnswerClarifyingQuestionsDebug({
    topic,
    label: 'extractNumberedQuestions',
    expectedCount,
    answeredIndices: numbered.map(q => q.n),
    note: `parsed ${expectedCount} numbered question(s) from planner reply`,
    text: questionsText || ''
  });
  const numberedList = numbered.length
    ? numbered.map(q => `${q.n}. ${q.text}`).join('\n\n')
    : questionsText;
  const baseInstr =
    `An agent emitted a NUMBERED list of clarifying questions below (\`1.\`, \`2.\`, \`3.\`, ...). ` +
    `There are EXACTLY ${expectedCount} numbered questions. You MUST produce EXACTLY ${expectedCount} numbered answers (\`1.\` ... \`${expectedCount}.\`), one per question, in order. ` +
    `Each numbered item is a separate question that MUST be answered — do not skip any, even if the question contains sub-options (a)/(b)/(c); address each sub-option within its answer. ` +
    `Output ONLY the answers as a NUMBERED list using the SAME numbers as the questions, with EXACTLY one numbered answer per question. ` +
    `Do not restate the questions. Do not include preamble, headers, or trailing commentary.${actionVerbositySuffix()}`;

  const autoAnswerClarifyingQuestionsSystemPrompt = 'You answer numbered clarifying questions. Output ONLY a numbered list using the EXACT format `1. answer\n\n2. answer ...`. No bullets, no headers, no preamble, no commentary, no caveman compression.';

  async function callOnce(extraNote) {
    const payload = buildPayload(
      globalRules,
      autoAnswerClarifyingQuestionsSystemPrompt,
      baseInstr + (extraNote || ''),
      `## Conversation History\n${fullContext}\n\n## Clarifying Questions to Answer (count=${expectedCount})\n${numberedList}`,
      ctxSection
    );
    appendAutoAnswerClarifyingQuestionsDebug({
      topic, label: 'auto-answer-clarifying-questions-payload', expectedCount,
      answeredIndices: [],
      note: `payload sent to runClaude (untruncated)`,
      text: String(payload || '')
    });
    const result = await runClaude(payload, { silent: true, label: 'auto-answer-clarifying-questions', role: 'assessment' });
    appendAutoAnswerClarifyingQuestionsDebug({
      topic, label: 'auto-answer-clarifying-questions-raw-response', expectedCount,
      answeredIndices: [],
      note: `FULL untouched runClaude text BEFORE normalizeAnswerText (callOnce)`,
      text: String(result && result.text || '')
    });
    return result;
  }

  function normalizeAnswerText(s) {
    // Tolerate model formatting drift: `**N.**`, `N)`, `Q N.`, `Answer N:`, leading `>` quote,
    // bullet `- N.` prefixes. Output is normalized to canonical `N. ` line starts.
    return (s || '').split('\n').map(line => {
      let l = line;
      // Strip leading blockquote markers `> ` / `>> `.
      l = l.replace(/^(\s*)(?:>\s*)+/, '$1');
      // Strip leading markdown headings `### ` / `## ` / `# ` before a numbered marker.
      l = l.replace(/^(\s*)#{1,6}\s+(?=(?:\*\*)?\s*(?:Q\s*|Answer\s*|Question\s*)?\d+(?:\.|\)|:|\*\*))/i, '$1');
      // Strip leading bullets `- ` / `* ` / `+ ` followed by a numbered marker (any of the forms below).
      l = l.replace(/^(\s*)[-*+]\s+(?=(?:\*\*)?\s*(?:Q\s*|Answer\s*|Question\s*)?\d+(?:\.|\)|:|\*\*))/i, '$1');
      // `**N.**` / `**N)**` / `**N:**` -> `N.`
      l = l.replace(/^(\s*)\*\*\s*(\d+)\s*[.\):]?\s*\*\*\s*/, '$1$2. ');
      // Unmatched leading `**N.` / `**N)` / `**N:` (closing `**` missing) -> `N.`
      l = l.replace(/^(\s*)\*\*\s*(\d+)\s*[.\):]\s+/, '$1$2. ');
      // `N)` / `N:` -> `N.`
      l = l.replace(/^(\s*)(\d+)\s*[\):]\s+/, '$1$2. ');
      // `Q N.` / `Question N.` / `Answer N.` (also `Q N:` / `Q N)`) -> `N.`
      l = l.replace(/^(\s*)(?:Q|Question|Answer)\s*(\d+)\s*[.\):]\s+/i, '$1$2. ');
      return l;
    }).join('\n');
  }
  // Backward-compat alias — older code paths / tests may still reference this name.
  const stripLeadingBullets = normalizeAnswerText;

  function countAnswers(text) {
    return getAnsweredIndices(text).size;
  }

  function getAnsweredIndices(text) {
    const seen = new Set();
    const re = /^\s*(\d+)\.\s+/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (n >= 1 && n <= expectedCount) seen.add(n);
    }
    return seen;
  }

  function parseAnswersByIndex(text, callerLabel) {
    const map = new Map();
    const re = /^\s*(\d+)\.\s+([\s\S]*?)(?=^\s*\d+\.\s+|(?![\s\S]))/gm;
    const traces = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      const body = m[2].trim();
      const preview = body.slice(0, 80);
      let outcome;
      if (n < 1 || n > expectedCount) outcome = 'dropped-out-of-range';
      else if (map.has(n)) outcome = 'dropped-duplicate';
      else { map.set(n, body); outcome = 'kept'; }
      traces.push({ n, preview, outcome });
    }
    try {
      appendAutoAnswerClarifyingQuestionsDebug({
        topic, label: `parseAnswersByIndex${callerLabel ? `:${callerLabel}` : ''}`,
        expectedCount,
        answeredIndices: traces.map(t => t.n),
        note: `regex hits=${traces.length}; outcomes=${JSON.stringify(traces)}`,
        text: ''
      });
    } catch {}
    return map;
  }

  function renderMerged(map) {
    return Array.from(map.keys()).sort((a, b) => a - b).map(n => `${n}. ${map.get(n)}`).join('\n\n');
  }

  async function callOnceForMissing(missingIndices) {
    const missingNumberedList = numbered.filter(q => missingIndices.includes(q.n)).map(q => `${q.n}. ${q.text}`).join('\n\n');
    const note = `\n\nIMPORTANT: A prior attempt returned answers for some questions but skipped the following. Only answer remaining questions: ${missingIndices.join(', ')}.\n\nSTRICT OUTPUT FORMAT (mandatory):\n- Each answer MUST start on its own line with EXACTLY \`N. <answer>\` where N is one of ${missingIndices.join(', ')} (digit, dot, single space, then the answer).\n- Do NOT use \`**N.**\`, \`N)\`, \`N:\`, \`Q N.\`, \`Answer N:\`, bullets (\`- \`/\`* \`), markdown headings (\`### \`), or blockquote markers (\`> \`).\n- Separate answers with one blank line.\n- No preamble, no closing remarks, no merging multiple answers into one line.\n- You MUST emit one line per number in ${missingIndices.join(', ')}; do NOT collapse to a single answer.`;
    const payload = buildPayload(
      globalRules,
      autoAnswerClarifyingQuestionsSystemPrompt,
      baseInstr + note,
      `## Conversation History\n${fullContext}\n\n## Clarifying Questions to Answer (only answer numbers ${missingIndices.join(', ')})\n${missingNumberedList}`,
      ctxSection
    );
    appendAutoAnswerClarifyingQuestionsDebug({
      topic, label: 'auto-answer-clarifying-questions-missing-payload', expectedCount,
      answeredIndices: missingIndices,
      note: `missing-only payload sent to runClaude (untruncated); missing=[${missingIndices.join(',')}]`,
      text: String(payload || '')
    });
    const result = await runClaude(payload, { silent: true, label: 'auto-answer-clarifying-questions-missing', role: 'assessment' });
    appendAutoAnswerClarifyingQuestionsDebug({
      topic, label: 'auto-answer-clarifying-questions-missing-raw-response', expectedCount,
      answeredIndices: missingIndices,
      note: `FULL untouched runClaude text BEFORE normalizeAnswerText (callOnceForMissing); missing=[${missingIndices.join(',')}]`,
      text: String(result && result.text || '')
    });
    return result;
  }

  // stopReason/continuations needed by buildUsageFooter below — omitting them throws ReferenceError.
  let { text, model, usage, costUsd, fallbackNote, effortNote, stopReason, continuations } = await callOnce('');
  appendAutoAnswerClarifyingQuestionsDebug({
    topic, label: 'auto-answer-clarifying-questions', expectedCount,
    answeredIndices: Array.from(getAnsweredIndices(text)),
    text: text || ''
  });
  text = normalizeAnswerText(text);
  appendAutoAnswerClarifyingQuestionsDebug({
    topic, label: 'auto-answer-clarifying-questions-normalized', expectedCount,
    answeredIndices: Array.from(getAnsweredIndices(text)),
    note: 'FULL normalized text AFTER normalizeAnswerText (callOnce)',
    text: text || ''
  });
  let merged = parseAnswersByIndex(text, 'callOnce');
  if (expectedCount > 1 && merged.size < expectedCount) {
    log(`Auto-answer-clarifying-questions returned ${merged.size} of ${expectedCount} answers — retrying once with stricter framing.`);
    const retryNote = `\n\nIMPORTANT: A prior attempt returned fewer than ${expectedCount} answers. You MUST emit all ${expectedCount} numbered answers this time, even if some answers are short. Do not merge multiple questions into one answer.`;
    const retry = await callOnce(retryNote);
    appendAutoAnswerClarifyingQuestionsDebug({
      topic, label: 'auto-answer-clarifying-questions (retry)', expectedCount,
      answeredIndices: Array.from(getAnsweredIndices(retry.text)),
      text: retry.text || ''
    });
    const cleanedRetry = normalizeAnswerText(retry.text);
    const retryMap = parseAnswersByIndex(cleanedRetry, 'retry');
    if (retryMap.size > merged.size) {
      // Carry stopReason/continuations from retry so footer matches retry result.
      ({ model, usage, costUsd, fallbackNote, effortNote, stopReason, continuations } = retry);
      merged = retryMap;
    }
    if (merged.size < expectedCount) {
      const missing = [];
      for (let n = 1; n <= expectedCount; n++) if (!merged.has(n)) missing.push(n);
      log(`Auto-answer-clarifying-questions still missing answers ${missing.join(', ')} — single re-prompt for only missing questions.`);
      try {
        const second = await callOnceForMissing(missing);
        appendAutoAnswerClarifyingQuestionsDebug({
          topic, label: 'auto-answer-clarifying-questions-missing', expectedCount,
          answeredIndices: Array.from(getAnsweredIndices(second.text)),
          note: `re-prompted for missing: ${missing.join(',')}`,
          text: second.text || ''
        });
        const cleanedSecond = normalizeAnswerText(second.text);
        const secondMap = parseAnswersByIndex(cleanedSecond, 'missing');
        for (const [n, ans] of secondMap) if (!merged.has(n) && missing.includes(n)) merged.set(n, ans);
      } catch (e) { log(`Single re-prompt for missing answers failed: ${e.message}`); }
    }
    if (merged.size < expectedCount) {
      const stillMissing = [];
      for (let n = 1; n <= expectedCount; n++) if (!merged.has(n)) stillMissing.push(n);
      log(`Escalating to per-question fan-out for ${stillMissing.length} remaining question(s): ${stillMissing.join(', ')}.`);
      const perQ = await Promise.all(stillMissing.map(async n => {
        try {
          const r = await callOnceForMissing([n]);
          appendAutoAnswerClarifyingQuestionsDebug({
            topic, label: `auto-answer-clarifying-questions-q${n}`, expectedCount,
            answeredIndices: Array.from(getAnsweredIndices(r.text)),
            text: r.text || ''
          });
          const cleaned = normalizeAnswerText(r.text);
          const map = parseAnswersByIndex(cleaned, `q${n}`);
          return { n, ans: map.get(n) || null };
        } catch (e) { log(`per-question fan-out for Q${n} failed: ${e.message}`); return { n, ans: null }; }
      }));
      for (const { n, ans } of perQ) if (ans && !merged.has(n)) merged.set(n, ans);
    }
    if (merged.size > 0) text = renderMerged(merged);
  }

  // Guarantee non-silent failure: any question still unanswered gets a visible placeholder
  // so the user can see exactly which Qs the assessment agent dropped.
  const finalMissing = [];
  for (let n = 1; n <= expectedCount; n++) if (!merged.has(n)) finalMissing.push(n);
  if (finalMissing.length > 0) {
    for (const n of finalMissing) {
      merged.set(n, '_(auto-answer-clarifying-questions failed — please answer manually; see .state/auto-answer-clarifying-questions-debug.log)_');
    }
    incrementAutoAnswerClarifyingQuestionsFailures(topic, finalMissing.length);
    log(`Auto-answer-clarifying-questions left ${finalMissing.length} placeholder(s) for Q${finalMissing.join(', ')} — see .state/auto-answer-clarifying-questions-debug.log.`);
    text = renderMerged(merged);
  }
  appendAutoAnswerClarifyingQuestionsDebug({
    topic, label: 'auto-answer-clarifying-questions-summary', expectedCount,
    answeredIndices: Array.from(merged.keys()).sort((a, b) => a - b),
    note: `final merged.size=${merged.size}; missing=[${finalMissing.join(',')}]`,
    text: text || ''
  });

  const footer = await buildUsageFooter(model, usage, costUsd, fallbackNote, effortNote, { stopReason, continuations });
  // Pre-fill auto-answer-clarifying-questionss into the "## User Reply to Questions" section so the
  // user can edit/confirm before submitting. The pipeline still waits for the
  // user to press ENTER (empty reply -> pass-through via readUserReplyFromHistory).
  const submitNote = headerName === AUTO_REPLY_HEADER
    ? '_(Auto-filled by assessment agent — auto-submitted, no manual confirmation.)_'
    : '_(Auto-filled by assessment agent — type :submit (or :s), or press ENTER twice on consecutive blank lines, to submit. Edit these replies first if needed.)_';
  const body = `${text.trim()}\n\n${submitNote}${footer}`;
  try {
    const mergedPreview = Array.from(merged.keys()).sort((a, b) => a - b).map(n => {
      const v = merged.get(n) || '';
      return `${n} -> ${v.slice(0, 120)}`;
    }).join('\n');
    appendAutoAnswerClarifyingQuestionsDebug({
      topic, label: 'auto-answer-clarifying-questions-pre-append', expectedCount,
      answeredIndices: Array.from(merged.keys()).sort((a, b) => a - b),
      note: `appendToFile target header="## ${headerName}"; mergedSize=${merged.size}; bodyLen=${body.length}`,
      text: `=== MERGED MAP (n -> first 120 chars) ===\n${mergedPreview}\n=== RENDERED BODY ===\n${body}`
    });
  } catch {}
  appendToFile(historyPath, `## ${headerName}`, body, { appendUserPromptSuffix: false });
  writeAutoAnswerClarifyingQuestionsSig(topic, body);
}

async function handleClarifyingQuestionsIfAny() {
  const questions = lastAgentResponseContainsClarifyingQuestions();
  if (!questions) return false;
  // Flush any unsaved VS Code editor buffers BEFORE inspecting the history file
  // so a user mid-edit isn't clobbered by auto-fill. Mirrors the pause-window ordering.
  // `force: true` -> bypass per-run throttle; user is about to interact with file.
  saveAllVsCodeBuffers({ force: true });
  const existingReply = readUserReplyFromHistory();
  const priorAutoHash = readAutoAnswerClarifyingQuestionsSig(topic);
  const existingIsAutoFill = !!(existingReply && priorAutoHash && hashBody(existingReply) === priorAutoHash);
  // Marker-based detection (c): the auto-fill footer is a stable marker. If existingReply
  // lacks the footer, treat as user-authored regardless of signature hash mismatch path.
  const AUTOFILL_MARKER = '_(Auto-filled by assessment agent';
  const hasAutoFillMarker = !!(existingReply && existingReply.includes(AUTOFILL_MARKER));
  const userAuthored = !!(existingReply && !existingIsAutoFill && !hasAutoFillMarker);

  const explicitAutoAnswer = (topicConfig.autoAnswerClarifyingQuestions != null) ? !!topicConfig.autoAnswerClarifyingQuestions : !!config.autoAnswerClarifyingQuestions;
  const autoSubmit = (topicConfig.autoAnswerClarifyingQuestionsAndSubmit != null) ? !!topicConfig.autoAnswerClarifyingQuestionsAndSubmit : !!config.autoAnswerClarifyingQuestionsAndSubmit;
  // `auto-answer-clarifying-questions-and-submit: true` implies `auto-answer-clarifying-questions: true`.
  const autoAnswerClarifyingQuestions = explicitAutoAnswer || autoSubmit;
  if (userAuthored) {
    log('Existing "## User Reply to Questions" block differs from prior auto-fill signature — treating as user-authored. Skipping auto-fill.');
  } else if (autoAnswerClarifyingQuestions) {
    const headerName = autoSubmit ? AUTO_REPLY_HEADER : USER_REPLY_HEADER;
    // Remove the empty trailing `## User Prompt` placeholder left by the preceding
    // phase (appendUserPromptSuffix: true) so the reply block doesn't end up below
    // a redundant prompt header + `---` divider.
    stripTrailingUserPrompt(historyPath);
    await autoAnswerClarifyingQuestionsClarifyingQuestions(questions, { headerName });
    log(`Auto-answer-clarifying-questionss written to "## ${headerName}"${autoSubmit ? ' — auto-submitting without manual confirmation.' : ' — pipeline paused awaiting user submit.'}`);
  } else if (!existingReply) {
    stripTrailingUserPrompt(historyPath);
    appendToFile(historyPath, '## User Reply to Questions', '', { appendUserPromptSuffix: false });
  }
  // Item 2: `auto-answer-clarifying-questions-and-submit` skips the manual ENTER-twice pause when a fresh
  // auto-answer-clarifying-questions was just written (gated by `auto-answer-clarifying-questions`). User-authored replies still
  // pause — we don't want to silently submit something the user is mid-editing.
  if (autoSubmit && autoAnswerClarifyingQuestions && !userAuthored) {
    log('auto-answer-clarifying-questions-and-submit=true — proceeding without manual confirmation.');
    return true;
  }
  startClarifyingQuestionWait();
  // QA gap 5 — route clarifying-question CLI through the cross-process
  // clarifier-lock so parallel agents serialise on the single interactive
  // channel. FIFO, tag = "<topic>/<role>" so the user sees who is asking.
  const _clarifier = require('./lib/clarifier-lock');
  const _clarTag = `${topic}/${(typeof roleArg === 'string' && roleArg) || 'agent'}`;
  const _releaseClarifier = await _clarifier.acquire(_clarTag);
  let reply;
  try {
    reply = await promptForUserReply(questions);
  } finally {
    try { _releaseClarifier(); } catch {}
  }
  // Commit any prompt-file edits the user made during the pause window BEFORE we
  // mutate the history file with their typed reply. Mirrors the initial-run ordering.
  if (configUtils.cfgRead(topicConfig, config, 'stage-and-commit', true)) {
    try { await saveUserChanges(); } catch (e) { log(`saveUserChanges during clarify-pause failed: ${e.message}`); }
  }
  if (reply && reply.trim()) {
    const lock = acquireFileLock(historyPath);
    try {
      const content = fs.readFileSync(historyPath, 'utf8');
      // Replace entire body of last "## User Reply to Questions" section
      // (auto-answer-clarifying-questions may have pre-filled it; user-typed reply overrides).
      const re = /(##\s+(?:User Reply to Questions|Auto Reply to Clarifying Questions)\s*\n)([\s\S]*?)(?=\n##\s|$)/i;
      const lastIdx = content.search(new RegExp('##\\s+(?:User Reply to Questions|Auto Reply to Clarifying Questions)\\s*\\n(?![\\s\\S]*##\\s+(?:User Reply to Questions|Auto Reply to Clarifying Questions))', 'i'));
      let updated;
      if (lastIdx >= 0) {
        const before = content.slice(0, lastIdx);
        const after = content.slice(lastIdx);
        updated = before + after.replace(re, `$1\n${reply.trim()}\n`);
      } else {
        updated = content.replace(re, `$1\n${reply.trim()}\n`);
      }
      fs.writeFileSync(historyPath, updated, 'utf8');
    } finally { releaseFileLock(lock); }
    log('User reply captured. Continuing pipeline.');
  } else {
    log('Empty reply received — using "## User Reply to Questions" block from prompt file. Continuing pipeline.');
  }
  return true;
}

// ── Phase runner (pipeline-aware) ─────────────────────────────────────────────

// =========================================================================
// Pipeline orchestration: runPhase dispatches one phase, runPipeline walks
// the full PIPELINES[name] array, handles token-limit waits + clarifying
// question pauses + state-checkpoint writes for resume.
// =========================================================================
async function runPhase(phaseName, { isFinal, hasPlanning, subsFromPrompt, isRerun = false }) {
  refreshHistoryPath();
  const noSuffix = !isFinal;
  switch (phaseName) {
    case 'planning':
      await runPlanning(noSuffix, { isRerun });
      break;
    case 'coding':
      if (hasPlanning && plannedSubtasks) await runCodingParallel(plannedSubtasks, noSuffix);
      else if (hasPlanning) await runCodingFromPlan(noSuffix);
      else if (subsFromPrompt) await runCodingParallel(subsFromPrompt, noSuffix, { noPlanning: true });
      else await runCoding(noSuffix);
      break;
    case 'assessment':
      if (subsFromPrompt && getParallelAssessmentAgents()) await runAssessmentParallel(subsFromPrompt, noSuffix);
      else await runAssessment(noSuffix, { parallelTaskCount: subsFromPrompt ? subsFromPrompt.length : 0 });
      break;
    case 'ask':
      await runAsk(noSuffix);
      break;
    case 'fix':
      stripTrailingUserPrompt(historyPath);
      if (subsFromPrompt && getParallelAssessmentAgents()) await runCodingAssessmentParallel(subsFromPrompt, noSuffix);
      else await runCodingAssessment(noSuffix, { parallelTaskCount: subsFromPrompt ? subsFromPrompt.length : 0 });
      break;
  }
}

async function waitUntilWithCountdown(targetDate) {
  const targetMs = targetDate instanceof Date ? targetDate.getTime() : Number(targetDate);
  process.stdout.write('\n');
  while (true) {
    const remaining = targetMs - Date.now();
    if (remaining <= 0) break;
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    process.stdout.write(`\r⏳ Session resets in ${hh}:${mm}:${ss} — please keep this terminal open…`);
    await new Promise(res => setTimeout(res, 1000));
  }
  process.stdout.write('\r✅ Session reset — resuming pipeline in-process…\n');
}

async function handleTokenLimitInline(instant, pipelineName, fromPhaseIndex) {
  const resetMs = instant.getTime();
  appendAutoResumeLog(`Inline wait started. topic="${topic}" pipeline="${pipelineName}" fromPhaseIndex=${fromPhaseIndex} resetAt=${instant.toISOString()}`);

  // Signal during inline countdown: chime, log, and exit. Recovery uses
  // `hrun <topic>-cont` because saveResumeState() writes `.state/<topic>.json`
  // but no wake-queue entry exists for token-limit interruptions (only the
  // network-error path enqueues). `hresume` would find nothing and refuse.
  const onSignal = (sig) => {
    // SIGINT chime removed: signal-handler exit during token-limit wait is a
    // user-initiated interrupt, not one of the five allowed sound events.
    appendAutoResumeLog(`Signal ${sig} during inline wait — exiting. Resume manually with \`hrun ${topic}-cont\`.`);
    process.stdout.write(`\nInterrupted — resume manually with \`hrun ${topic}-cont\` after ${instant.toLocaleString()}.\n`);
    // INVARIANT (load-bearing): this handler MUST terminate the process. The
    // post-teardown fall-through below (~line 3575) removed its signal guard and
    // relies on `onSignal` exiting, so reaching the resume path proves no signal
    // fired. Softening this to a non-exiting handler reintroduces the guard bug.
    process.exit(0);
  };
  const sighupHandler = () => onSignal('SIGHUP');
  const sigintHandler = () => onSignal('SIGINT');
  if (process.platform !== 'win32') process.once('SIGHUP', sighupHandler);
  process.once('SIGINT', sigintHandler);

  // Token-limit chime: fired once when entering the auto-resume wait so the
  // user is alerted that the pipeline has paused for the rate-limit reset.
  // Distinct from completion/error/clarifying/queue-fetch tones.
  try { playTokenLimitSound(); } catch {}

  try {
    await waitUntilWithCountdown(instant);
  } catch (err) {
    if (process.platform !== 'win32') process.off('SIGHUP', sighupHandler);
    process.off('SIGINT', sigintHandler);
    appendAutoResumeLog(`waitUntilWithCountdown threw: ${err.message}`);
    throw err;
  }

  if (process.platform !== 'win32') process.off('SIGHUP', sighupHandler);
  process.off('SIGINT', sigintHandler);
  // Removed a stale early-return guard that tested an undeclared flag here; the
  // reference threw a ReferenceError on every reset, was caught downstream as
  // "Inline resume failed", and blocked auto-resume. The signal path (`onSignal`)
  // already calls `process.exit(0)`, so reaching this point guarantees no signal
  // fired; no guard flag is needed.

  appendAutoResumeLog(`Inline wait complete. Resuming pipeline="${pipelineName}" fromPhaseIndex=${fromPhaseIndex}`);
  log(`Session reset — resuming topic "${topic}" pipeline "${pipelineName}" from phase index ${fromPhaseIndex}.`);
  // Re-invoke remaining pipeline in-process — parent holds all state in memory, no state-file round-trip.
  await runPipeline(pipelineName, fromPhaseIndex, { skipStateWrites: true });
}

// Return contract (LOAD-BEARING — do not change without updating all callers):
//   `true`  -> pipeline ran every phase to completion in-process
//   `false` -> paused/auto-resumed (token limit, network error, scheduled retry)
// Throws on hard failure via `die()` -> `process.exit` (finally still skipped, since `die` exits).
// Callers gate `emitEndOfRunLimits` and `dequeueAndTriggerNext` on `=== true`; introducing any
// other return value would silently stop queue drain. If a new "paused" path is added, return
// `false` (not a new sentinel) so the existing gates keep working.
// ── Cross-provider token-exhaustion fallback ────────────────────────────────
// When the active provider exhausts its token/quota window, walk the user-
// configured `fallback-providers` chain instead of waiting for the reset. The
// next provider id is persisted into topic-config.json (`provider` + a
// `fallback-state` object recording tried providers) so an `hresume` after a
// crash continues on the swapped provider rather than reverting to the
// original. Clearing of `fallback-state` happens on pipeline success.

function _loadFallbackChain() {
  const chain = configUtils.cfgRead(topicConfig, config, 'fallback-providers', null);
  if (!Array.isArray(chain)) return [];
  return chain.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
}

function _getTriedProviders() {
  const fs2 = topicConfig && topicConfig['fallback-state'] && topicConfig['fallback-state'].tried;
  return Array.isArray(fs2) ? fs2.slice() : [];
}

function _persistFallbackSwap(newProviderId, triedList) {
  try {
    const fresh = configUtils.loadConfig(topicConfigPath);
    fresh.provider = newProviderId;
    fresh['fallback-state'] = { tried: triedList, swappedAt: new Date().toISOString(), original: (fresh['fallback-state'] && fresh['fallback-state'].original) || (topicConfig && topicConfig['fallback-state'] && topicConfig['fallback-state'].original) || (triedList[0] || null) };
    configUtils.writeConfig(topicConfigPath, fresh);
    topicConfig = fresh;
  } catch (e) {
    try { appendAutoResumeLog(`fallback-state persist failed: ${e.message}`); } catch {}
  }
}

function _clearFallbackState() {
  try {
    if (!topicConfig || !topicConfig['fallback-state']) return;
    const fresh = configUtils.loadConfig(topicConfigPath);
    delete fresh['fallback-state'];
    configUtils.writeConfig(topicConfigPath, fresh);
    topicConfig = fresh;
  } catch {}
}

// Attempt to swap to the next un-tried provider in the fallback chain.
// Returns `true` if a swap+rerun was triggered (caller should return false from
// the pipeline). Returns `false` if no usable fallback remained.
async function _tryProviderFallback(err, pipelineName, phaseIndex) {
  const chain = _loadFallbackChain();
  if (!chain.length) return false;
  let currentId = null;
  try { currentId = getProvider().id; } catch {}
  const tried = _getTriedProviders();
  if (currentId && !tried.includes(currentId)) tried.push(currentId);
  const remaining = chain.filter(id => !tried.includes(id));
  if (!remaining.length) {
    const instant = err && err.tokenReset ? nextResetInstant(err.tokenReset) : null;
    const resetMsg = instant ? ` Earliest token reset: ${instant.toLocaleString()}.` : '';
    const banner = `\n⛔ Auto-resume not possible on [${tried.join(', ')}].${resetMsg}\n`;
    process.stdout.write(banner);
    try { log(banner.trim()); } catch {}
    return { swapped: false, exhausted: true };
  }
  const nextId = remaining[0];
  _persistFallbackSwap(nextId, tried);
  const banner = `\nTokens have run out on ${currentId || 'current provider'}. Falling back to ${nextId}.\n`;
  process.stdout.write(banner);
  try { log(banner.trim()); } catch {}
  // Re-enter the pipeline at the same phase — getProvider() now reads the
  // newly-persisted `provider` field from topicConfig and spawns the next CLI.
  await runPipeline(pipelineName, phaseIndex);
  return { swapped: true, exhausted: false };
}

async function runPipeline(pipelineName, startIndex = 0, { skipStateWrites = false } = {}) {
  const phases = PIPELINES[pipelineName];
  if (!phases) die(`Unknown pipeline "${pipelineName}"`);
  const hasPlanning = phases.includes('planning');
  let subsFromPrompt = (!hasPlanning) ? resolveSubtasksFromPrompt() : null;

  if (phases.length > 1) log(`=== Pipeline: ${phases.join(' → ')} ===`);

  // Belt-and-braces reset of module-level `plannedSubtasks` at the top of every pipeline run.
  // `runPlanning` already resets it, but a resume that skips planning (`startIndex > 0`) or a
  // pipeline that omits planning entirely would otherwise inherit a stale value from a prior
  // `runPipeline` invocation in the same Node process.
  plannedSubtasks = null;

  // Strict in-order phase execution: index ascends, no re-ordering. The PIPELINES table is the
  // single source of truth so a `caf` run is always coding → assessment → fix. (Prior-turn
  // remediation headers left in the history file are content, not phase state, and cannot
  // re-trigger `runFix` here.)
  for (let i = startIndex; i < phases.length; i++) {
    const phaseName = phases[i];
    const isFinal = (i === phases.length - 1);
    if (!skipStateWrites) {
      saveResumeState(topic, { pipeline: pipelineName, phaseIndex: i, phase: phaseName, ts: new Date().toISOString() });
    }
    try {
      await runPhase(phaseName, { isFinal, hasPlanning, subsFromPrompt });
    } catch (err) {
      const autoResume = (configUtils.cfgRead(topicConfig, config, 'auto-resume-on-token-limit', true) !== false);
      let providerAutoResume = true;
      try { providerAutoResume = getProvider().capabilities.autoResume !== false; } catch {}
      // Cross-provider fallback hook: classify non-Claude quota errors too so the
      // chain triggers regardless of whether `err.tokenReset` was parsed. The
      // swap takes precedence over the wait-for-reset / monthly-cap paths since
      // the user opted into fallback by configuring `fallback-providers`.
      if (!err.tokensExhausted) {
        try {
          const cls = classifyTokensExhausted(err);
          if (cls.kind === 'tokens-exhausted') err.tokensExhausted = true;
        } catch {}
      }
      if (err.tokensExhausted || err.tokenReset || err.monthlyCapHit) {
        try {
          const fb = await _tryProviderFallback(err, pipelineName, i);
          if (fb && fb.swapped) return false;
          if (fb && fb.exhausted) {
            // Whole chain tried — skip the auto-resume scheduling that follows
            // and exit cleanly so the user sees the printed "not possible" line
            // as the final word.
            clearResumeState(topic);
            _clearFallbackState();
            process.exit(2);
            return false;
          }
        } catch (fbErr) {
          try { appendAutoResumeLog(`provider-fallback attempt failed: ${fbErr.message}`); } catch {}
        }
      }
      if (err.monthlyCapHit) {
        clearResumeState(topic);
        const banner = `\n⛔ Monthly spend cap hit. Run \`hresume\` after billing reset.\n`;
        process.stdout.write(banner);
        log(banner.trim());
        process.exit(2);
        return false;
      }
      if (err.networkError) {
        saveResumeState(topic, { pipeline: pipelineName, phaseIndex: i, phase: phaseName, ts: new Date().toISOString() });
        if (providerAutoResume) enqueueWake(topic, pipelineName, i, Date.now());
        appendAutoResumeLog(`Network error after retries — manual hresume needed. topic="${topic}" pipeline="${pipelineName}" phaseIndex=${i} phase="${phaseName}"`);
        const banner = `\n⚠ Network unreachable after retries during '${phaseName}' phase of topic "${topic}". State saved. Run \`hresume\` (or \`hresume ${topic}\`) once the network is back to continue from this phase.\n`;
        console.error(banner);
        log(banner.trim());
        process.exit(2);
        return false;
      }
      const instant = err.tokenReset ? nextResetInstant(err.tokenReset) : null;
      if (err.tokenReset && autoResume && providerAutoResume && instant) {
        // Inline-only auto-resume: block with countdown until the reset instant,
        // then re-enter runPipeline at the failed phase.
        log(`Token limit hit — inline auto-resume triggered for ${instant.toString()} (topic "${topic}", phase "${phaseName}").`);
        saveResumeState(topic, { pipeline: pipelineName, phaseIndex: i, phase: phaseName, ts: new Date().toISOString() });
        try {
          await handleTokenLimitInline(instant, pipelineName, i);
        } catch (inlineErr) {
          // Inline-failure recovery: use `hrun <topic>-cont` for the same reason
          // as the signal-path message — the token-limit branch saves
          // `.state/<topic>.json` but never enqueues a wake-queue job, so
          // `hresume` would find no matching topic and bail.
          log(`Inline resume failed (${inlineErr.message}) — resume manually with \`hrun ${topic}-cont\`.`);
          appendAutoResumeLog(`Inline resume failed.`, inlineErr);
          process.stdout.write(`\nToken limit hit and inline resume failed. Resume manually with \`hrun ${topic}-cont\` after ${instant.toLocaleString()}.\n`);
        }
        return false;
      }
      if (err.tokenReset && autoResume && !providerAutoResume) {
        log(`[WARN] Token limit hit but provider "${getProvider().id}" does not support auto-resume (capabilities.autoResume=false). Exiting without scheduling wake task.`);
      }
      if (err.tokenReset && autoResume && !instant) {
        log(`Detected token-limit message but could not parse the reset time — falling back to error exit. State preserved; resume manually with \`hrun ${topic}-cont\`.`);
      } else {
        clearResumeState(topic);
      }
      // Context-window overflow: surface an actionable, non-cryptic message
      // instead of the generic "Phase N (X) failed: Claude exited with code 1".
      // The Provider tagged err.contextLimitHit when stderr/stdout carried a
      // prompt-too-long / context-length / invalid_request_error+tokens signature.
      // Run the same auto-restore cleanup that the die() path triggers via process.on('exit').
      if (err.contextLimitHit) {
        const mdl = err.attemptedModel || 'unknown';
        const friendly = `Token limit reached for model ${mdl}; consider switching model or clearing memory.`;
        log(friendly);
        process.stdout.write(`\n⛔ ${friendly}\n  Phase: ${phaseName} (topic "${topic}")\n  Edit topic-config.json \`models.${phaseName}\` to a larger-context model, or run \`hclear-memory\` to shrink the prompt, then re-run.\n`);
        process.exit(2);
        return false;
      }
      die(`Phase ${i + 1} (${phaseName}) failed: ${err.message}${err.cliOutput ? `\n--- claude output ---\n${err.cliOutput}\n---` : ''}`);
    }
    if (phaseName === 'planning' && getMaxConcurrentAgents() > 1) {
      // plannedSubtasks already set inside runPlanning
    }
    // Always check for clarifying questions — even on final phase — so the user can reply
    // before the pipeline exits. Final-phase pause still beeps + waits via the reminder loop.
    {
      const paused = await handleClarifyingQuestionsIfAny();
      // Re-run any phase that asked clarifying questions once a reply arrives —
      // including 'fix' (remediation coding), which was previously excluded and
      // caused the harness to silently skip the fix after an auto-reply.
      if (paused && (phaseName === 'planning' || phaseName === 'coding' || phaseName === 'fix')) {
        // Persist a marker BEFORE the first await so token-exhaustion during the rerun
        // doesn't silently drop the fact that a reply was captured.  On resume (hresume or
        // inline countdown) the reply is already in the history file; this marker tells the
        // resumed runPipeline that the re-run is safe to kick off directly.
        try {
          const fresh = configUtils.loadConfig(topicConfigPath);
          fresh.clarifier = { pendingReply: { phase: phaseName, phaseIndex: i, capturedAt: new Date().toISOString() } };
          configUtils.writeConfig(topicConfigPath, fresh);
          topicConfig = fresh;
        } catch (e) { appendAutoResumeLog(`clarifier pendingReply persist failed: ${e.message}`); }

        // Re-run the same phase so it consumes the user's reply and produces an actual
        // plan/code body — otherwise downstream phases would see only the clarifying questions.
        log(`Re-running ${phaseName} to produce actionable output from the reply.`);
        try {
          await runPhase(phaseName, { isFinal, hasPlanning, subsFromPrompt, isRerun: true });
          appendAutoResumeLog(`runPipeline: clarifying-rerun complete phase="${phaseName}" phaseIndex=${i} -> falling through to post-loop return true`);
          // Re-check: if the rerun emitted ANOTHER clarifying-questions block, pause again
          // instead of silently advancing to the next phase with an incomplete body.
          // Resume note: resume state still points at this same `phaseIndex` (no isRerun flag
          // persisted). If the user closes the terminal during this 2nd pause and runs
          // `hresume`, the phase restarts as a fresh `runPhase` (initial run, not rerun) —
          // it re-reads history including the user's 2nd reply and produces new output.
          // That is acceptable: agents are idempotent given identical history input, and a
          // fresh run sees both replies in-context. Do NOT persist an `isRerun` flag without
          // also designing recovery for it.
          await handleClarifyingQuestionsIfAny();
          // For the 'fix' phase (last in all pipelines), also run assessment when the
          // pipeline originally included one — satisfies "full response includes assessment
          // if requested by the initial run command." For planning/coding, the for-loop
          // naturally continues to downstream phases; fix has no loop tail so we append
          // assessment explicitly.
          if (phaseName === 'fix' && phases.includes('assessment')) {
            log('Running assessment of the re-run fix output (pipeline included assessment).');
            await runPhase('assessment', { isFinal: true, hasPlanning, subsFromPrompt });
          }
        } catch (rerunErr) {
          const errClass = classifyTokenError(rerunErr);
          if (errClass.kind === 'monthly' || rerunErr.monthlyCapHit) {
            const banner = `\n⛔ Monthly spend limit reached while re-running ${phaseName} phase for topic "${topic}" after clarifying-question reply.\nYour reply has been saved to the history file. Resume manually with \`hresume ${topic}\` once the spend limit is reset.\n`;
            console.error(banner.trim());
            log(banner.trim());
            return false;
          }
          const rerunInstant = rerunErr.tokenReset ? nextResetInstant(rerunErr.tokenReset) : null;
          const autoResume = (configUtils.cfgRead(topicConfig, config, 'auto-resume-on-token-limit', true) !== false);
          let providerAutoResume = true;
          try { providerAutoResume = getProvider().capabilities.autoResume !== false; } catch {}
          if (rerunErr.tokenReset && autoResume && providerAutoResume && rerunInstant) {
            log(`Token limit hit during clarifier rerun (phase "${phaseName}") — waiting for reset then re-dispatching. Reply is saved.`);
            appendAutoResumeLog(`clarifier rerun token-limit: topic="${topic}" phase="${phaseName}" phaseIndex=${i} resetAt=${rerunInstant.toISOString()}`);
            // Inline-only path: block with countdown then re-enter runPipeline.
            saveResumeState(topic, { pipeline: pipelineName, phaseIndex: i, phase: phaseName, ts: new Date().toISOString() });
            try {
              await handleTokenLimitInline(rerunInstant, pipelineName, i);
            } catch (inlineErr) {
              log(`Inline resume failed during clarifier rerun (${inlineErr.message}) — resume manually with \`hresume ${topic}\`.`);
              appendAutoResumeLog(`clarifier rerun inline resume failed: ${inlineErr.message}`);
              process.stdout.write(`\nToken limit during clarifier rerun and inline resume failed. Resume manually with \`hresume ${topic}\` after ${rerunInstant.toLocaleString()}. Reply is saved.\n`);
            }
            return false;
          }
          // Not a classifiable token error — propagate to outer handler.
          throw rerunErr;
        }

        // Rerun succeeded — clear the pendingReply marker.
        try {
          const fresh = configUtils.loadConfig(topicConfigPath);
          delete fresh.clarifier;
          configUtils.writeConfig(topicConfigPath, fresh);
          topicConfig = fresh;
        } catch (e) { appendAutoResumeLog(`clarifier pendingReply clear failed: ${e.message}`); }
      }
    }
    if (phases.length > 1) log(`Phase ${i + 1} (${phaseName}) complete.`);
  }
  if (phases.length > 1) log('Pipeline done.');

  // Post-pipeline housekeeping for any pipeline that ends with a code-touching phase.
  const final = phases[phases.length - 1];
  if (final === 'coding' || final === 'fix') {
    updateTopicContext();
    await stageAndCommitChanges();
  }
  clearResumeState(topic);
  // Wipe fallback bookkeeping once the pipeline completes — leftover `tried`
  // entries would otherwise leak into the next prompt and skip providers the
  // user has since restored quota on.
  _clearFallbackState();
  return true;
}

async function emitEndOfRunLimits() {
  try {
    const line = await buildEndOfRunLimitsLine();
    if (!line) return;
    const lock = acquireFileLock(historyPath);
    try {
      // Insert BEFORE any trailing `## User Prompt` block — otherwise the limits line
      // lands under the next prompt heading (placement bug from prior turn).
      const content = fs.readFileSync(historyPath, 'utf8');
      const m = content.match(/((?:\n+(?:---\s*\n+)?)## User Prompt\s*\n*)$/);
      if (m) {
        const before = content.slice(0, content.length - m[1].length);
        fs.writeFileSync(historyPath, before + line + m[1], 'utf8');
      } else {
        fs.appendFileSync(historyPath, line + '\n');
      }
    } finally {
      releaseFileLock(lock);
    }
    process.stdout.write(line + '\n');
  } catch { /* non-fatal */ }
}

// ── Prompt queue (post-pipeline auto-advance) ─────────────────────────────────
// =========================================================================
// prompt-queue.md integration: inject head block into history, drain
// remaining blocks, parallel-batch dispatch when ≥2 unheld + flag set.
// =========================================================================
const promptQueue = require('./prompt-queue');
// `topicDirPath` is also referenced from the REPL handler block above (~line
// 2111). It works there only because `function` declarations hoist; do NOT
// refactor to `const`/arrow without first moving the definition to the top of
// the module.
function topicDirPath() { return path.dirname(historyPath); }

// pipeline artefact: in-process queue drain uses CMD_MAP compiled at process start;
// changes to CMD_MAP by a coding agent mid-run are NOT visible to subsequent drain
// cycles — restart hrun after harness changes that modify CMD_MAP.
// Map shorthand -> pipeline key understood by runPipeline / role dispatch.
function resolvePipelineFromShorthand(shorthand) {
  // a: 'ask' (was 'assessment' — use 'af' for assess+fix, 'assessment' full name still works).
  // ac: ask then coding; af: assess+fix (unchanged).
  const CMD_MAP = {
    p: 'planning', c: 'coding', a: 'ask', ac: 'ask-code', f: 'fix',
    af: 'assess-fix', pc: 'plan-code', caf: 'code-assess-fix',
    all: 'all', pcaf: 'all', cont: 'continue',
  };
  return CMD_MAP[String(shorthand || '').toLowerCase()] || null;
}

const _normalizeHistory = require('./normalize-history');

// pipelineShorthand (optional): when present, appended to the history header so
// the reader can see which pipeline was requested alongside the queued prompt.
function injectQueuedPromptIntoHistory(body, pipelineShorthand) {
  // Single unified branch: strip EVERY trailing empty `## User Prompt[...]`
  // placeholder (tagged or untagged) — there may be more than one stacked due
  // to a prior phase running both `appendUserPromptSuffix` and
  // `appendUserPromptSuffixToFile`, or a previous abort leaving an extra —
  // then unconditionally append exactly one tagged `(From the Queue)` section.
  // Prior reuse-vs-fresh-append dichotomy removed: `parseConversationContext`
  // anchors by header, not by line offset, so in-place rewrite is no longer
  // required to preserve downstream parsing.
  const lock = acquireFileLock(historyPath);
  try {
    const txt = fs.readFileSync(historyPath, 'utf8');
    const tailBuf = Buffer.from(txt.slice(Math.max(0, txt.length - 80)), 'utf8');
    const tailHex = tailBuf.toString('hex');
    const tailRaw = tailBuf.toString('utf8');
    const { collapsed } = _normalizeHistory.stripAllTrailingEmptyPlaceholders(txt);
    // Pass pipelineShorthand so buildQueueInjectedContent can annotate the header.
    const next = _normalizeHistory.buildQueueInjectedContent(txt, body, pipelineShorthand);
    log(`queue-inject: unified branch — collapsed ${collapsed} trailing empty \`## User Prompt\` placeholder(s); appended tagged section.`);
    // Single unified debug entry; `branch` retains legacy `reuse`/`fresh-append`
    // string for telemetry continuity, and `unified:true` flags the new path.
    appendQueueInjectDebug({
      branch: collapsed > 0 ? 'reuse' : 'fresh-append',
      unified: true,
      collapsed,
      matched: collapsed > 0,
      tailLen: tailBuf.length,
      tailHex,
      tailRaw,
    });
    fs.writeFileSync(historyPath, next, 'utf8');
    // Post-write debug: confirms the file SHA-256 and tail content after inject so
    // a runPlanning SHA-256 mismatch reveals a race between writeFileSync and the read.
    {
      const _postWriteSha = crypto.createHash('sha256').update(next, 'utf8').digest('hex').slice(0, 16);
      appendAutoResumeLog(`injectQueuedPromptIntoHistory[postWrite]: sha256=${_postWriteSha} tailRaw=${JSON.stringify(next.slice(Math.max(0, next.length - 200)))}`);
    }
  } finally { releaseFileLock(lock); }
}

// Parse the latest `## User Prompt` block for an optional per-prompt header
// (pipeline / model / provider — SAME grammar as the prompt-queue, delegated to
// `promptQueue.parsePromptFileHeader`). When a header is recognised, physically
// strip the header line from the block in-place so downstream agents never read
// it as prompt content. Returns `{ pipeline, model, provider }` (any field may
// be null) or null when no header is present. Best-effort: returns null on any
// read/parse error so a malformed first line just runs the prompt verbatim.
function applyPromptFileHeader(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  // Anchor to the LAST `## User Prompt` block (negative lookahead forbids a later
  // one) — mirrors `fillEmptyPromptFromQueueOrInteractive`'s trailing-prompt regex.
  const re = /(\n+(?:---\s*\n+)?)## User Prompt[^\n]*\n((?:(?!\n## User Prompt)[\s\S])*)$/;
  const m = re.exec(content);
  if (!m) return null;
  const body = m[2] || '';
  let parsed;
  try { parsed = promptQueue.parsePromptFileHeader(body); } catch { return null; }
  if (!parsed || (!parsed.pipeline && !parsed.model && !parsed.provider)) return null;
  // Header recognised: rewrite the block with the header line removed (under
  // lock) so the agent sees only real prompt content. `parsed.body` is the body
  // with the header line already stripped by `parseBlock`.
  if (parsed.body !== body) {
    const bodyStart = m.index + m[0].length - body.length;
    const next = content.slice(0, bodyStart) + parsed.body + content.slice(bodyStart + body.length);
    const lock = acquireFileLock(filePath);
    try { fs.writeFileSync(filePath, next, 'utf8'); } finally { releaseFileLock(lock); }
  }
  return { pipeline: parsed.pipeline, model: parsed.model, provider: parsed.provider };
}

// Drain-time forced editor flush. The two queue-drain entry points re-read the
// queue file from disk; if the user just typed a prompt into an unsaved editor
// buffer, the read sees a stale (often first-line-only) version and dequeues a
// truncated block. Force a save-all (bypassing the once-per-run throttle via
// `_resetEditorFlushThrottle`), then settle for the hardcoded 200ms so the
// write lands before any `parseQueue`/`dequeueFirstUnheld`. The `{force:true}`
// call deliberately bypasses both the per-run throttle and the
// `HARNESS_EDITOR_FLUSHED` cross-process guard (the user may have typed a new
// prompt since the entry-point flush), so we do NOT clear that env flag —
// leaving it set still suppresses the redundant non-force child flush.
function _drainFlushEditorBuffers() {
  _resetEditorFlushThrottle();
  flushEditorBuffers({ force: true });
  // Settle delay is hardcoded (200ms) — flush timing is no longer configurable.
  sleepMs(200);
}

// When the latest `## User Prompt` block is empty, pull the first unheld block
// from the queue and inject its body in place of the empty prompt. Pipeline
// from the invoked `hrun` always wins — we use ONLY the queued block's body,
// never its header. If the queue is empty or every block is held, fall back
// to an interactive multi-line prompt (no opt-out). Always-on; runs once at
// dispatch entry before `stripTrailingUserPrompt`.
async function fillEmptyPromptFromQueueOrInteractive() {
  // Persist unsaved editor buffers before the first queue read so a half-saved
  // prompt block is not dequeued in its truncated form.
  _drainFlushEditorBuffers();
  let content;
  try { content = fs.readFileSync(historyPath, 'utf8'); } catch { return; }
  // Trailing `## User Prompt[...]` placeholder. Header line + body to EOF.
  // Anchor to the LAST `## User Prompt` — negative lookahead in body forbids
  // a later `## User Prompt`, so multi-section histories (prior user prompts
  // followed by responses + a new trailing placeholder) match the placeholder
  // only, not the first prompt. Treat the prompt as "empty" when the body,
  // after stripping HTML comments (`<!-- ... -->`) and whitespace, is empty —
  // placeholders containing only `<!-- ... -->` must trigger dequeue.
  const trailingPromptRe = /(\n+(?:---\s*\n+)?)## User Prompt[^\n]*\n((?:(?!\n## User Prompt)[\s\S])*)$/;
  const m = trailingPromptRe.exec(content);
  if (!m) return;
  const bodyRaw = m[2] || '';
  const bodyStripped = bodyRaw.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (bodyStripped.length > 0) return; // non-empty trailing prompt — keep user content
  const td = topicDirPath();
  const qPath = require('path').join(td, 'prompt-queue.md');
  // Forensic queue-file-stat — mirrors `dequeueAndTriggerNext` so a freshly
  // written-but-empty file can be told apart from a stale/unchanged one when
  // diagnosing missed dequeues.
  try {
    const crypto = require('crypto');
    if (fs.existsSync(qPath)) {
      const st = fs.statSync(qPath);
      const head = fs.readFileSync(qPath, 'utf8').slice(0, 200);
      const sha = crypto.createHash('sha1').update(head).digest('hex').slice(0, 12);
      appendAutoResumeLog(`fillEmptyPrompt: queue-file-stat path="${qPath}" mtimeMs=${st.mtimeMs} mtimeIso=${new Date(st.mtimeMs).toISOString()} size=${st.size} head200Sha1=${sha}`);
    } else {
      appendAutoResumeLog(`fillEmptyPrompt: queue-file-stat path="${qPath}" missing`);
    }
  } catch (statErr) {
    appendAutoResumeLog(`fillEmptyPrompt: queue-file-stat failed: ${statErr.message}`);
  }
  let blocksLen = 0, unheldCount = 0;
  try {
    const { blocks } = promptQueue.parseQueue(td);
    blocksLen = blocks.length;
    unheldCount = blocks.filter(b => !b.held).length;
  } catch {}
  // Log only when dequeue is about to fire — avoids log bloat on every `hrun`.
  appendAutoResumeLog(`fillEmptyPrompt: empty placeholder detected — bodyBytes=${bodyRaw.length} bodyStrippedBytes=0 queuePath="${qPath}" blocks=${blocksLen} unheld=${unheldCount}`);
  const defaultPipelineShort = String(configUtils.cfgRead(topicConfig, config, 'promptQueue.defaultPipeline', 'all') || 'all');
  const picked = promptQueue.dequeueFirstUnheld(td, { defaultPipeline: defaultPipelineShort, log });
  appendAutoResumeLog(`dequeueFirstUnheld[fillEmptyPrompt]: topic="${topic}" hasBlock=${!!(picked && picked.block)} warning="${picked && picked.warning || ''}" remaining=${picked && picked.remainingCount} skippedHeld=${picked && picked.skippedHeld || 0} bodyHead="${picked && picked.block ? String(picked.block.body || '').replace(/\s+/g,' ').slice(0,80) : ''}"`);
  if (picked && picked.block) {
    if (picked.skippedHeld) log(`prompt-queue: skipped ${picked.skippedHeld} held block(s) while searching for an unheld prompt.`);
    log(`prompt-queue: latest user prompt was empty — injecting body from queue head (${picked.remainingCount} block(s) remain). Pipeline from invocation wins; queued header ignored.`);
    appendAutoResumeLog(`dequeueFirstUnheld[fillEmptyPrompt]: injecting popped body into history`);
    injectQueuedPromptIntoHistory(picked.block.body);
    return;
  }
  // One-shot retry — VS Code's async write may not have landed within the
  // initial 400 ms flush window. Sleep `fill-prompt-retry-flush-ms` (0 = off)
  // and re-read the queue once before falling back to the interactive prompt.
  const retryMs = Number(configUtils.cfgRead(topicConfig, config, 'fill-prompt-retry-flush-ms', 500)) || 0;
  let retry = null;
  if (retryMs > 0) {
    appendAutoResumeLog(`fillEmptyPrompt: first dequeue empty — retrying after ${retryMs}ms flush wait`);
    sleepMs(retryMs);
    // Re-drain editor buffers before the second read — cheap insurance for the
    // case where VS Code held the write in an unsaved buffer past the first drain.
    _drainFlushEditorBuffers();
    retry = promptQueue.dequeueFirstUnheld(td, { defaultPipeline: defaultPipelineShort, log });
    appendAutoResumeLog(`dequeueFirstUnheld[fillEmptyPrompt-retry]: topic="${topic}" hasBlock=${!!(retry && retry.block)} warning="${retry && retry.warning || ''}" remaining=${retry && retry.remainingCount} skippedHeld=${retry && retry.skippedHeld || 0}`);
    if (retry && retry.block) {
      if (retry.skippedHeld) log(`prompt-queue: skipped ${retry.skippedHeld} held block(s) while searching for an unheld prompt.`);
      log(`prompt-queue: queue head arrived after retry — injecting body (${retry.remainingCount} block(s) remain). Pipeline from invocation wins; queued header ignored.`);
      appendAutoResumeLog(`dequeueFirstUnheld[fillEmptyPrompt-retry]: injecting popped body into history`);
      injectQueuedPromptIntoHistory(retry.block.body);
      return;
    }
  }
  // Queue empty or all blocks held — prompt user interactively.
  // Use the LATEST non-null dequeue result (retry wins) so the printed reason
  // reflects the final state, not the stale first attempt.
  const last = retry || picked;
  const reason = last && last.warning === 'all-held'
    ? `all ${last.remainingCount} queued block(s) are marked (hold)`
    : 'queue is empty';
  process.stdout.write(
`\n ─────────────────────────────────────────────────────────
 EMPTY PROMPT detected and ${reason}.
 Type your prompt below; finish with :submit (or :s), or press ENTER twice on consecutive blank lines.
 ─────────────────────────────────────────────────────────\n> `);
  const reply = await readMultilinePromptFromStdin();
  if (!reply || !reply.trim()) die('No prompt provided. Aborting.');
  injectQueuedPromptIntoHistory(reply);
}

// Minimal multi-line stdin reader for the empty-prompt fallback. Kept separate
// from `promptForUserReply` (which is tailored to the "clarifying questions"
// flow and consults `## User Reply to Questions` on disk).
function readMultilinePromptFromStdin() {
  return new Promise(resolve => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const lines = [];
    rl.on('line', (line) => {
      const t = line.trim();
      if (t === ':submit' || t === ':s') { rl.close(); return; }
      if (t === '' && lines.length && !lines[lines.length - 1].trim()) {
        // Two consecutive blank lines -> submit.
        lines.pop();
        rl.close();
        return;
      }
      lines.push(line);
    });
    rl.on('close', () => {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      resolve(lines.join('\n'));
    });
  });
}

async function _maybeRunParallelQueueBatch({ defaultPipelineShort }) {
  // Honour `run-queue-in-parallel` (was dead config — QA blocker 1).
  // Drains every non-`(hold)` block in ONE parallel batch via parallel-batch
  // orchestrator. `(hold)` blocks stay in the queue and resume serial drain.
  const enabled = configUtils.cfgRead(topicConfig, config, 'run-queue-in-parallel', false);
  // The real runner now spawns child `run-agent.js` processes (see
  // parallel-batch.makeSpawnRunner) and re-injects each child's output via the
  // FIFO staging splice — no more prompt loss. `parallel-runner-implemented`
  // is retained as an explicit kill-switch (default true): set it false to fall
  // back to the sequential drain without disabling `run-queue-in-parallel`.
  const runnerImpl = configUtils.cfgRead(topicConfig, config, 'parallel-runner-implemented', true);
  appendAutoResumeLog(`_maybeRunParallelQueueBatch: topic="${topic}" enabled=${enabled} runnerImpl=${runnerImpl}`);
  if (!enabled) return false;
  if (!runnerImpl) {
    appendAutoResumeLog(`_maybeRunParallelQueueBatch: STUB-GUARD active (kill-switch) — run-queue-in-parallel=true but parallel-runner-implemented=false; falling back to sequential drain.`);
    log(`prompt-queue: run-queue-in-parallel=true but parallel-runner-implemented=false — kill-switch on, using sequential drain.`);
    return false;
  }
  const td = topicDirPath();
  const { blocks } = promptQueue.parseQueue(td);
  const parallelBatch = require('./lib/parallel-batch');
  const { parallel: nonHold } = parallelBatch.partitionBlocks(blocks);
  appendAutoResumeLog(`_maybeRunParallelQueueBatch: nonHold=${nonHold.length} totalBlocks=${blocks.length}`);
  if (nonHold.length < 2) return false; // single block — fall through to sequential
  const maxParallel = Number(configUtils.cfgRead(topicConfig, config, 'max-parallel-agents', 4)) || 4;
  const stageAndCommit = !!configUtils.cfgRead(topicConfig, config, 'stage-and-commit', false);
  const useWorktree = !!configUtils.cfgRead(topicConfig, config, 'parallel-use-worktree', false);
  // Parallel-batch runner now uses the module-level repoRoot (topic root-repo) instead of
  // the hardcoded ROOT, so spawned child agents and their git ops target the same dir.
  // Drain the queue of every non-hold block atomically so the runner owns them.
  const drained = [];
  for (let i = 0; i < nonHold.length; i++) {
    const popped = promptQueue.dequeueFirstUnheld(td, { defaultPipeline: defaultPipelineShort, log });
    appendAutoResumeLog(`dequeueFirstUnheld[parallelBatch#${i}]: topic="${topic}" hasBlock=${!!(popped && popped.block)} remaining=${popped && popped.remainingCount} skippedHeld=${popped && popped.skippedHeld || 0} bodyHead="${popped && popped.block ? String(popped.block.body || '').replace(/\s+/g,' ').slice(0,80) : ''}"`);
    if (!popped || !popped.block) break;
    drained.push(popped.block);
  }
  if (drained.length === 0) return false;
  // Audible cue: parallel batch fetched one or more prompts from the queue.
  // Single chime per batch (not per block) — multiple BELs would be noisy
  // and `_beepInFlight` would suppress them anyway. Uses the innocuous
  // queue-fetch tone, distinct from the clarifying/error chime.
  try { playQueueFetchSound(); appendAutoResumeLog(`prompt-queue: queue-fetch chime fired (parallel batch, drained=${drained.length})`); } catch {}
  // Trace post-implementation: the real spawn runner (makeSpawnRunner) drains
  // each block via a child process and re-injects its output through the FIFO
  // staging splice. Updated from the former "stub runner" wording, which is now
  // inaccurate and would mislead anyone debugging a missing-prompt report.
  appendAutoResumeLog(`_maybeRunParallelQueueBatch: drained=${drained.length} — real spawn runner will dispatch + re-inject bodies via FIFO splice`);
  log(`prompt-queue: run-queue-in-parallel=true — dispatching ${drained.length} block(s) in parallel (cap=${maxParallel}, worktree=${useWorktree}, combined-commit=${stageAndCommit}).`);
  const ts = new Date().toISOString();
  // Slots dir scoped under the harness root so the cross-process
  // `max-parallel-agents` cap is shared across every topic of THIS harness.
  const slotsDir = path.join(ROOT, '.state', 'parallel-slots');
  // Real runner: spawn a child `run-agent.js` per block against an ephemeral
  // sub-topic dir (AGENT_ORCH_TOPIC_DIR_OVERRIDE) and splice its output back —
  // replaces the former stub that silently ate prompts (QA FAIL #1).
  await parallelBatch.runParallelQueueBatch({
    topicDir: td,
    topicName: topic,
    historyPath,
    blocks: drained.map(b => ({ body: b.body, header: b.pipeline, slug: b.pipeline || 'task' })),
    maxParallel,
    stageAndCommit,
    useWorktree,
    repoRoot,
    timestamp: ts,
    slotsDir,
    log,
    runner: parallelBatch.makeSpawnRunner({
      execPath: process.execPath,
      runAgentPath: __filename,
      pipelineShort: defaultPipelineShort,
      parentTopicConfigPath: topicConfigPath,
      log,
    }),
  });
  return true;
}

async function dequeueAndTriggerNext({ manualSubmit = false } = {}) {
  // Persist unsaved editor buffers before the first queue re-read so the drain
  // dequeues fully-saved blocks, not a stale first-line-only version.
  _drainFlushEditorBuffers();
  // Loop-drain remaining queued blocks in-process. Recursion previously produced
  // N+1 `emitEndOfRunLimits` summaries (once per recursive drain + once at the
  // outer top-level callsite); the loop runs `runPipeline` repeatedly within a
  // single call so the outer callsite emits exactly one end-of-run summary.
  while (true) {
   try {
    const autoAdvance = configUtils.cfgRead(topicConfig, config, 'promptQueue.autoAdvance', true);
    const defaultPipelineShort = String(configUtils.cfgRead(topicConfig, config, 'promptQueue.defaultPipeline', 'all') || 'all');
    const td = topicDirPath();
    // Forensic stat (debug-only): log mtime + SHA of head bytes so a
    // stale-vs-fresh disagreement between "what user just saved" and
    // "what harness saw" is visible in `.state/auto-resume.log`. No
    // sleep/settle — `parseQueue` already re-reads disk every call, so
    // the next drain naturally picks up any save that completed before
    // dispatch. Gated on `promptQueue.debugStat` to keep normal drains
    // free of extra I/O.
    const qPath = require('path').join(td, 'prompt-queue.md');
    const debugStat = !!configUtils.cfgRead(topicConfig, config, 'promptQueue.debugStat', false);
    if (debugStat) {
      try {
        const crypto = require('crypto');
        if (fs.existsSync(qPath)) {
          const st = fs.statSync(qPath);
          const head = fs.readFileSync(qPath, 'utf8').slice(0, 200);
          const sha = crypto.createHash('sha1').update(head).digest('hex').slice(0, 12);
          appendAutoResumeLog(`dequeueAndTriggerNext: queue-file-stat path="${qPath}" mtimeMs=${st.mtimeMs} mtimeIso=${new Date(st.mtimeMs).toISOString()} size=${st.size} head200Sha1=${sha}`);
        } else {
          appendAutoResumeLog(`dequeueAndTriggerNext: queue-file-stat path="${qPath}" missing`);
        }
      } catch (statErr) {
        appendAutoResumeLog(`dequeueAndTriggerNext: queue-file-stat failed: ${statErr.message}`);
      }
    }
    const pending = promptQueue.queueLength(td);
    // User-visible re-read summary — distinguishes "harness used stale state"
    // (bug) from "user save raced drain" (timing) when the user sees
    // "drain halted: all N block(s) on hold".
    try {
      const { blocks } = promptQueue.parseQueue(td);
      const heldCount = blocks.filter(b => b.held).length;
      const unheldCount = blocks.length - heldCount;
      const iso = (fs.existsSync(qPath) ? new Date(fs.statSync(qPath).mtimeMs).toISOString() : 'n/a');
      log(`prompt-queue: re-read from disk at drain — mtime=${iso}, blocks=${blocks.length}, held=${heldCount}, unheld=${unheldCount}.`);
    } catch {}
    appendAutoResumeLog(`dequeueAndTriggerNext: entry topic="${topic}" topicDir="${td}" queueLength=${pending} autoAdvance=${autoAdvance} manualSubmit=${manualSubmit}`);
    if (pending === 0) { appendAutoResumeLog(`dequeueAndTriggerNext: early-return branch=empty (queueLength=0)`); return; }
    log(`prompt-queue: drain cycle start (queueLen=${pending}).`);
    // Parallel drain first if enabled — only kicks in when ≥2 unheld blocks
    // are pending and the flag is on; otherwise falls through to the
    // sequential path below.
    if (autoAdvance || manualSubmit) {
      try {
        const ran = await _maybeRunParallelQueueBatch({ defaultPipelineShort });
        if (ran) continue;
      } catch (pe) {
        log(`prompt-queue: parallel batch dispatch failed (${pe.message}) — falling back to sequential drain.`);
      }
    }
    if (!autoAdvance && !manualSubmit) {
      log(`prompt-queue: ${pending} pending block(s). Auto-advance is off — run \`hrun ${topic}-cont\` or use \`:queue-next\` to dispatch the head block.`);
      appendAutoResumeLog(`dequeueAndTriggerNext: early-return branch=autoAdvance-off pending=${pending}`);
      return;
    }
    const popped = promptQueue.dequeueFirstUnheld(td, { defaultPipeline: defaultPipelineShort, log });
    appendAutoResumeLog(`dequeueFirstUnheld[dequeueAndTriggerNext]: topic="${topic}" hasBlock=${!!(popped && popped.block)} warning="${popped && popped.warning || ''}" remaining=${popped && popped.remainingCount} skippedHeld=${popped && popped.skippedHeld || 0} bodyHead="${popped && popped.block ? String(popped.block.body || '').replace(/\s+/g,' ').slice(0,80) : ''}"`);
    if (!popped) { appendAutoResumeLog(`dequeueAndTriggerNext: early-return branch=missing-or-empty-file`); return; } // missing/empty file
    if (popped.warning === 'all-held') {
      log(`prompt-queue: drain halted: all ${popped.remainingCount} block(s) on hold, queue left intact.`);
      appendAutoResumeLog(`dequeueAndTriggerNext: early-return branch=all-held remaining=${popped.remainingCount}`);
      return;
    }
    if (!popped.block) { appendAutoResumeLog(`dequeueAndTriggerNext: early-return branch=unknown-shorthand warning="${popped.warning}"`); return; } // unknown-shorthand warning — queue untouched
    const { block, remainingCount, defaultedPipeline, skippedHeld } = popped;
    if (skippedHeld) log(`prompt-queue: skipped ${skippedHeld} held block(s), dequeued unheld block (pipeline=${block.pipeline}, remaining=${remainingCount}).`);
    const pipelineKey = resolvePipelineFromShorthand(block.pipeline);
    if (!pipelineKey) {
      log(`prompt-queue: shorthand "${block.pipeline}" resolved to no known pipeline — skipping.`);
      return;
    }
    if (defaultedPipeline) log(`prompt-queue: head block had no header — defaulting to "${defaultPipelineShort}" -> pipeline "${pipelineKey}".`);
    // Per-block model/provider override: when the queue header carried a
    // model token (e.g. `(hold) opus caf`, `gpt-4.1`, `sonnet`), mutate the
    // in-memory topicConfig for this pipeline run only. Snapshot the prior
    // values so the override is reverted in the finally below.
    const _prevProvider = topicConfig ? topicConfig.provider : undefined;
    const _prevModel    = topicConfig ? topicConfig.model    : undefined;
    const _prevModels   = topicConfig && topicConfig.models  ? { ...topicConfig.models } : undefined;
    let _overrodeTopicCfg = false;
    if (topicConfig && (block.model || block.provider)) {
      _overrodeTopicCfg = true;
      if (block.provider) topicConfig.provider = block.provider;
      if (block.model) {
        topicConfig.model = block.model;
        // Force the per-role table to follow so resolveRoleModel does not
        // shadow the queue override with a stale role-pinned id.
        topicConfig.models = topicConfig.models || {};
        for (const r of ['planning', 'coding', 'assessment', 'fix']) topicConfig.models[r] = block.model;
      }
      log(`prompt-queue: header model/provider override -> provider="${block.provider || topicConfig.provider}" model="${block.model || topicConfig.model}" (for this pipeline run only).`);
    }
    // Capture raw block text BEFORE inject so we can re-queue on failure
    // (preserves header line + body verbatim — `parseBlock` exposes `.raw`).
    const rawBlock = block.raw;
    // Pass block.pipeline so the history header records which shorthand was used.
    injectQueuedPromptIntoHistory(block.body, block.pipeline);
    // Audible cue: a new prompt was just fetched from the queue and injected
    // into history. Uses the distinct, innocuous `playQueueFetchSound` (NOT
    // the clarifying/error chime) so the user can tell "new work started"
    // from "needs my attention" purely by ear.
    try { playQueueFetchSound(); appendAutoResumeLog(`prompt-queue: queue-fetch chime fired (serial dequeue, pipeline="${pipelineKey}")`); } catch {}
    const bodySnippet = String(block.body || '').replace(/\s+/g, ' ').slice(0, 80);
    log(`prompt-queue: dequeued unheld block -> running pipeline "${pipelineKey}" in-process on topic "${topic}" (${remainingCount} block(s) remain). Body: "${bodySnippet}".`);
    // In-process continuation: invoke runPipeline directly so stdout/stderr stream
    // to the current terminal — no spawn, no new window. Same interpreter, same
    // history file, same interactive clarifying-question path. The freshly-injected
    // `## User Prompt` is what the in-process pipeline will pick up as its prompt,
    // so we do NOT strip it here.
    try {
      // Mirror the strict `=== true` gate the outer dispatch uses (see `runPipeline` return-contract comment).
      const completed = (await runPipeline(pipelineKey, 0)) === true;
      if (!completed) return false; // pipeline paused/aborted -> stop draining (paused state has its own resume; do NOT re-queue)
      continue; // loop back to drain the next queued block (if any)
    } catch (innerErr) {
      // In-process pipeline failed (not paused). Re-queue the popped block at
      // the head so the user's prompt is not lost, then abort the drain.
      // Spawning a fresh terminal here masked the real failure and confused
      // the topic state machine — the user wants the failure surfaced here.
      try { promptQueue.prependHead(topicDirPath(), rawBlock); }
      catch (rqErr) { log(`prompt-queue: re-queue after failure also failed: ${rqErr.message}`); }
      log(`prompt-queue: in-process pipeline failed (${innerErr.message}) — popped block restored at head of queue. Draining aborted; investigate the failure above and re-run \`hrun ${topic}-cont\` (or any queue-draining alias) to retry.`);
      // Audible cue: in-process pipeline stopped with error -> dedicated
      // error chime (distinct .wav) so the user can distinguish failure from
      // completion or clarifying-question events.
      try { playErrorSound(); } catch {}
      return;
    } finally {
      // Restore the snapshot regardless of pipeline outcome so a per-block
      // override does not leak into the next iteration of the drain loop.
      if (_overrodeTopicCfg && topicConfig) {
        topicConfig.provider = _prevProvider;
        topicConfig.model = _prevModel;
        if (_prevModels) topicConfig.models = _prevModels; else delete topicConfig.models;
      }
    }
   } catch (e) {
    log(`prompt-queue: dequeue failed (${e.message}) — queue left untouched.`);
    return;
   }
  }
}

// =========================================================================
// Dispatch IIFE: top-level entry. Flush IDE buffers -> auto-archive -> drain
// queue head -> run requested role or resume from saved state -> emit limits
// -> finally-gated drain of remaining queue blocks.
// =========================================================================
// ── Dispatch ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    // Lazily register the weekly models-reference refresh task. Idempotent + cheap when present.
    try {
      const { ensureModelsRefreshScheduled } = require('./schedule-models-refresh.js');
      ensureModelsRefreshScheduled();
    } catch (e) { /* non-fatal */ }
    // Dispatch entry = harness command (hrun/hresume) just typed. Force-flush so any
    // unsaved IDE edits get captured before the pipeline reads any files. Subsequent
    // per-phase calls are throttled -> no taskbar flash per phase.
    saveAllVsCodeBuffers({ force: true });
    await saveUserChanges();
    // Plain rotation only — compression path removed; never injects a summary block.
    await maybeAutoArchiveHistory(historyPath);
    // Startup sweep of stale `.parallel/*` sub-topic dirs (QA gap 5 — module
    // existed + was tested, but never invoked at boot). Best-effort.
    try {
      const _parallelBatchMod = require('./lib/parallel-batch');
      const _staleHours = Number(configUtils.cfgRead(topicConfig, config, 'parallel-stale-sweep-hours', 12)) || 12;
      const _removed = _parallelBatchMod.sweepStaleParallelDirs(path.dirname(historyPath), _staleHours);
      if (_removed && _removed.length) log(`parallel-sweep: removed ${_removed.length} stale sub-topic dir(s) older than ${_staleHours}h.`);
    } catch (e) { /* non-fatal */ }
    // Retroactively collapse any pre-existing stacked trailing `## User Prompt`
    // placeholders left behind by historical write paths or aborted runs. Runs
    // BEFORE the queue-fill / strip steps so they see a single canonical
    // trailing placeholder instead of a stack.
    try {
      const collapsed = _normalizeHistory.normalizeTrailingPromptStack(historyPath);
      if (collapsed > 0) log(`normalize-history: collapsed ${collapsed} duplicate trailing \`## User Prompt\` placeholder(s) at dispatch.`);
    } catch (e) { log(`normalize-history: ${e.message}`); }
    // Empty `## User Prompt` -> pull unheld queue block (body only) OR
    // prompt interactively. Always on; runs before stripTrailingUserPrompt
    // because that strip would erase the empty placeholder we detect here.
    await fillEmptyPromptFromQueueOrInteractive();
    stripTrailingUserPrompt(historyPath);
    // Per-prompt `## User Prompt` header: resolve pipeline + model/provider from
    // the first line of the latest prompt block. CLI-explicit role always wins
    // the pipeline; the header's model/provider is ALWAYS applied for this run
    // (snapshot + finally-restore mirrors the queue header override path).
    let _hdrOverrode = false, _hdrPrevProvider, _hdrPrevModel, _hdrPrevModels;
    {
      const _hdr = applyPromptFileHeader(historyPath);
      if (_hdr) {
        if (!roleExplicit && _hdr.pipeline) {
          const _resolved = resolvePipelineFromShorthand(_hdr.pipeline);
          if (_resolved) { roleArg = _resolved; log(`prompt-header: pipeline "${_hdr.pipeline}" -> "${roleArg}".`); }
        }
        if (topicConfig && (_hdr.model || _hdr.provider)) {
          _hdrOverrode = true;
          _hdrPrevProvider = topicConfig.provider;
          _hdrPrevModel = topicConfig.model;
          _hdrPrevModels = topicConfig.models ? { ...topicConfig.models } : undefined;
          if (_hdr.provider) topicConfig.provider = _hdr.provider;
          if (_hdr.model) {
            topicConfig.model = _hdr.model;
            topicConfig.models = topicConfig.models || {};
            for (const r of ['planning', 'coding', 'assessment', 'fix']) topicConfig.models[r] = _hdr.model;
          }
          // Record the override so per-phase `saveResumeState` persists it; an
          // auto-resume re-reads it from state since the header is gone from disk.
          _promptHeaderResumeOverride = { model: _hdr.model || null, provider: _hdr.provider || null };
          log(`prompt-header: model/provider override -> provider="${_hdr.provider || topicConfig.provider}" model="${_hdr.model || topicConfig.model}" (this run only).`);
        }
      }
    }
    // No CLI role and no header pipeline -> fall back to promptQueue.defaultPipeline.
    if (!roleArg) {
      const _dp = String(configUtils.cfgRead(topicConfig, config, 'promptQueue.defaultPipeline', 'all') || 'all');
      roleArg = resolvePipelineFromShorthand(_dp) || 'all';
      log(`prompt-header: no explicit role/header pipeline — defaulting to "${_dp}" -> "${roleArg}".`);
    }
    let pipelineResult = false;
    try {
      if (roleArg === 'continue') {
        const state = loadResumeState(topic);
        if (!state) die(`No resume state found for topic "${topic}" at ${path.relative(ROOT, statePathFor(topic))}. Nothing to continue.`);
        // Re-apply any per-prompt header model/provider persisted at first
        // dispatch. The header line was stripped from history then, so it can no
        // longer be re-parsed here — without this the resumed run reverts to the
        // default model. Snapshot + finally-restore mirrors the first-dispatch path.
        if (topicConfig && (state.headerModel || state.headerProvider)) {
          _hdrOverrode = true;
          _hdrPrevProvider = topicConfig.provider;
          _hdrPrevModel = topicConfig.model;
          _hdrPrevModels = topicConfig.models ? { ...topicConfig.models } : undefined;
          if (state.headerProvider) topicConfig.provider = state.headerProvider;
          if (state.headerModel) {
            topicConfig.model = state.headerModel;
            topicConfig.models = topicConfig.models || {};
            for (const r of ['planning', 'coding', 'assessment', 'fix']) topicConfig.models[r] = state.headerModel;
          }
          // Keep it live so this resumed pipeline's own saveResumeState writes re-persist it.
          _promptHeaderResumeOverride = { model: state.headerModel || null, provider: state.headerProvider || null };
          log(`prompt-header: re-applied persisted resume override -> provider="${state.headerProvider || topicConfig.provider}" model="${state.headerModel || topicConfig.model}".`);
        }
        log(`Continuing topic "${topic}" pipeline "${state.pipeline}" from phase "${state.phase}" (index ${state.phaseIndex}).`);
        pipelineResult = await runPipeline(state.pipeline, state.phaseIndex);
        appendAutoResumeLog(`dispatch: post-runPipeline (continue) pipelineResult typeof=${typeof pipelineResult} value=${JSON.stringify(pipelineResult)}`);
      } else {
        pipelineResult = await runPipeline(roleArg, 0);
        appendAutoResumeLog(`dispatch: post-runPipeline (roleArg="${roleArg}") pipelineResult typeof=${typeof pipelineResult} value=${JSON.stringify(pipelineResult)}`);
      }
      if (pipelineResult === true) await emitEndOfRunLimits();
    } finally {
      // Restore any prompt-file header model/provider override BEFORE the queue
      // drain so the per-prompt override never leaks into subsequent queued
      // blocks (which carry their own headers).
      if (_hdrOverrode && topicConfig) {
        topicConfig.provider = _hdrPrevProvider;
        topicConfig.model = _hdrPrevModel;
        if (_hdrPrevModels) topicConfig.models = _hdrPrevModels; else delete topicConfig.models;
      }
      // finally-gated dequeue: only drain on confirmed `=== true` completion.
      // Rule 5: thrown / die() / process.exit() / auto-resume `return false` paths
      // intentionally skip dequeue so an errored run does not advance the queue.
      const _drainGate = (pipelineResult === true);
      appendAutoResumeLog(`dispatch: dequeue-gate pipelineResult=${JSON.stringify(pipelineResult)} -> drain=${_drainGate}`);
      if (_drainGate) await dequeueAndTriggerNext();
      // Last-prompt-pipeline-finished chime: fire ONCE per dispatch, ONLY when
      // the queue is empty after drain returns (i.e., this dispatch processed
      // the final available prompt). Re-reads queue length post-drain so
      // "all-held" early-return and any held-only remainder do NOT chime —
      // only a genuinely empty queue counts as "last prompt finished".
      // Uses dedicated `playCompletionSound` (distinct .wav) so the
      // session-ending event has its own tone separate from clarifying/error.
      if (_drainGate) {
        let _postDrainPending = -1;
        try { _postDrainPending = promptQueue.queueLength(topicDirPath()); } catch {}
        if (_postDrainPending === 0) {
          try { playCompletionSound(); appendAutoResumeLog(`dispatch: completion-chime fired (queue empty post-drain pending=${_postDrainPending})`); }
          catch (chimeErr) { appendAutoResumeLog(`dispatch: completion-chime failed: ${chimeErr && chimeErr.message}`); }
        } else {
          appendAutoResumeLog(`dispatch: completion-chime skipped (post-drain pending=${_postDrainPending} — not last prompt)`);
        }
      }
    }
  } catch (err) {
    try { appendAutoResumeLog(`dispatch: outer-catch err="${err && err.message}" stack=${err && err.stack ? String(err.stack).split('\n').slice(0,3).join(' | ') : 'n/a'}`); } catch {}
    ensureAutoModelRestored();
    // Audible cue: dispatch-level pipeline error -> dedicated error chime
    // before `die()` exits so failure has a tone distinct from completion.
    try { playErrorSound(); } catch {}
    die(err.message);
  }
  ensureAutoModelRestored();
})().catch((err) => {
  // Backstop: if the dispatch IIFE itself rejects (e.g., an await above the
  // try/catch throws), the `finally`-gated dequeue never runs and the outer
  // catch never sees it. Log here so the next failing run leaves forensic
  // evidence in `.state/auto-resume.log` instead of vanishing silently.
  try { appendAutoResumeLog(`dispatch: IIFE-reject err="${err && err.message}" stack=${err && err.stack ? String(err.stack).split('\n').slice(0,3).join(' | ') : 'n/a'}`); } catch {}
  try { process.exitCode = 1; } catch {}
});
