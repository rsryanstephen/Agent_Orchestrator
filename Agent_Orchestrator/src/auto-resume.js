#!/usr/bin/env node
/**
 * Auto-resume wake handler — invoked by schtasks (Windows) or `at` (Unix) at the
 * scheduled token-reset time. Reads `.state/wake-queue.json`, then for each job
 * spawns `run-agent.js <topic> continue` (detached, parallel). The continue
 * command reads `.state/<topic>.json` to pick up the exact failed phase and
 * runs the remaining pipeline.
 *
 * --diagnose    Tail the last 50 lines of .state/auto-resume.log and exit.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const configUtils = require('./config-utils');

// All paths resolved via __dirname so the scheduled task's working directory is irrelevant.
const HARNESS = path.resolve(__dirname, '..');
const ROOT = path.resolve(HARNESS, '..');
const STATE_DIR = path.resolve(HARNESS, '.state');
const QUEUE = path.resolve(STATE_DIR, 'wake-queue.json');
const LOG_PATH = path.resolve(STATE_DIR, 'auto-resume.log');

// ---------- Diagnostic logger writing to .state/auto-resume.log ----------
function appendLog(msg, err) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [auto-resume.js] ${msg}`;
    if (err) line += `\n  ERROR: ${err.message}\n  STACK: ${(err.stack || err.message).split('\n').join('\n  ')}`;
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch {}
}

function log(msg) { console.log(`[auto-resume.js] ${msg}`); }

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---------- --diagnose mode: tail recent log lines and exit ----------
// --diagnose: tail last 50 lines of the log.
if (process.argv.includes('--diagnose')) {
  if (!fs.existsSync(LOG_PATH)) {
    console.log(`[auto-resume.js] No diagnostic log found at ${LOG_PATH}`);
    process.exit(0);
  }
  const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n');
  const tail = lines.slice(-51).join('\n');
  console.log(tail);
  process.exit(0);
}

try {
  appendLog(
    `Startup. argv=${JSON.stringify(process.argv.slice(2))} ` +
    `cwd=${process.cwd()} execPath=${process.execPath} ` +
    `envKeyCount=${Object.keys(process.env).length} ` +
    `HARNESS=${HARNESS} ROOT=${ROOT}`
  );

  // ---------- File-lock helpers (PID-stamped, stale-owner recovery) ----------
  function acquireFileLock(targetPath) {
    const lockPath = targetPath + '.lock';
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return lockPath; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const ownerPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
          try { process.kill(ownerPid, 0); } catch { fs.unlinkSync(lockPath); continue; }
        } catch {}
        sleepMs(100);
      }
    }
    throw new Error(`Timed out waiting for file lock on ${targetPath}`);
  }

  function releaseFileLock(lockPath) { try { fs.unlinkSync(lockPath); } catch {} }

  // Flush unsaved IDE/editor buffers the moment `hresume` is typed -> any file
  // edited just before submitting the command is written to disk BEFORE the
  // wake queue is read or any child run-agent.js is spawned. Skipped on the
  // --diagnose path above. Best-effort (silent on failure).
  try { require('./editor-buffer-flush').flushEditorBuffers(); } catch {}

  // ---------- Arg parse: optional topic / id / "all" filter (defaults to "all") ----------
  // Mirrors `hrun` / `hrun all` default: bare `hresume` with no args resumes every queued topic.
  let argv = process.argv.slice(2).filter(a => a !== '--diagnose');
  if (argv.length === 0) argv = ['all'];
  const filterArg = argv[0];

  // Resolve numeric ID → topic name (mirrors run-agent.js dispatch) when filtering by id.
  function resolveTopic(arg) {
    if (arg === 'all') return 'all';
    try {
      const cfgPath = configUtils.globalConfigPath();
      const cfg = configUtils.loadConfig(cfgPath);
      const ids = (cfg && (cfg['topic-ids'] || cfg.topicIds)) || null;
      if (ids && ids[arg]) return ids[arg];
    } catch {}
    return arg;
  }
  const filterTopic = resolveTopic(filterArg);

  // ---------- Read + atomically wipe wake-queue.json so concurrent enqueues don't lose jobs ----------
  if (!fs.existsSync(QUEUE)) {
    appendLog('No wake queue found — nothing to resume.');
    log('No wake queue found — nothing to resume.');
    process.exit(0);
  }

  let queue;
  const lock = acquireFileLock(QUEUE);
  try {
    try { queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8')); }
    catch (e) {
      releaseFileLock(lock);
      const msg = `Failed to read wake queue: ${e.message}`;
      appendLog(msg, e);
      log(msg);
      process.exit(1);
    }
    // Wipe queue immediately (atomic with read) so concurrent enqueue races don't lose jobs.
    try { fs.unlinkSync(QUEUE); } catch {}
  } finally {
    releaseFileLock(lock);
  }

  let jobs = (queue && queue.jobs) || [];
  if (jobs.length === 0) {
    appendLog('Wake queue empty.');
    log('Wake queue empty.');
    process.exit(0);
  }

  // ---------- Topic filter: matched jobs run; unmatched jobs restored to queue ----------
  if (filterTopic !== 'all') {
    const matched = jobs.filter(j => j.topic === filterTopic);
    const skipped = jobs.filter(j => j.topic !== filterTopic);
    if (matched.length === 0) {
      const msg = `No queued job for topic "${filterTopic}". Queue had: ${jobs.map(j => j.topic).join(', ')}`;
      appendLog(msg);
      log(msg);
      // Restore the queue file we wiped above so unfiltered topics aren't lost.
      const restoreLock = acquireFileLock(QUEUE);
      try { fs.writeFileSync(QUEUE, JSON.stringify({ jobs }, null, 2) + '\n', 'utf8'); }
      finally { releaseFileLock(restoreLock); }
      process.exit(0);
    }
    if (skipped.length > 0) {
      const restoreLock = acquireFileLock(QUEUE);
      try { fs.writeFileSync(QUEUE, JSON.stringify({ jobs: skipped }, null, 2) + '\n', 'utf8'); }
      finally { releaseFileLock(restoreLock); }
    }
    jobs = matched;
  }

  // ---------- Provider capability gate: bail if active provider can't auto-resume ----------
  // Provider capability gate: hard-disable auto-resume for providers that don't support it.
  try {
    const { getProvider } = require('./lib/providers/registry');
    const provider = getProvider();
    if (!provider.capabilities.autoResume) {
      const msg = `[WARN] Provider "${provider.id}" does not support auto-resume (capabilities.autoResume=false). Skipping resume for ${jobs.length} queued topic(s). Use a provider with autoResume=true (e.g. claude-code) to re-enable.`;
      appendLog(msg);
      log(msg);
      process.exit(0);
    }
  } catch (e) {
    appendLog(`Provider capability check failed: ${e.message} — proceeding with resume.`);
  }

  appendLog(`Resuming ${jobs.length} topic(s): ${jobs.map(j => j.topic).join(', ')}`);
  log(`Resuming ${jobs.length} topic(s): ${jobs.map(j => j.topic).join(', ')}`);

  // ---------- Parallel-batch staging recovery before each resume spawn ----------
  // Staging orphan recovery: before spawning each child, splice any staging
  // files left by a crashed parallel batch. Completed entries go into history;
  // incomplete entries (runner never finished) are re-prepended to the queue.
  const _parallelBatch = (() => { try { return require('./lib/parallel-batch'); } catch { return null; } })();
  if (_parallelBatch) {
    let _cfg;
    try { _cfg = configUtils.loadConfig(configUtils.globalConfigPath()); } catch { _cfg = {}; }
    for (const job of jobs) {
      try {
        const _topicDir = configUtils.topicDirFor(ROOT, _cfg, job.topic);
        const _histPath = path.join(_topicDir, `${job.topic}.md`);
        const _qPath = path.join(_topicDir, 'prompt-queue.md');
        const _r = _parallelBatch.recoverStagingOrphans(_topicDir, _histPath, _qPath);
        if (_r.spliced + _r.requeued > 0) {
          appendLog(`Staging recovery for "${job.topic}": ${_r.spliced} spliced into history, ${_r.requeued} re-queued.`);
          log(`Staging recovery for "${job.topic}": spliced=${_r.spliced} re-queued=${_r.requeued}.`);
        }
      } catch (e) {
        appendLog(`Staging recovery check failed for "${job.topic}": ${e.message}`);
      }
    }
  }

  // ---------- Terminal selection: read preferred-terminal config (legacy alias handled) ----------
  let resumeTerminal = 'git-bash';
  try {
    const cfgPath = configUtils.globalConfigPath();
    const cfg = configUtils.loadConfig(cfgPath);
    if (cfg) {
      const preferred = cfg['preferred-terminal'] || cfg.preferredTerminal;
      const legacy = cfg['resume-terminal'] || cfg.resumeTerminal;
      if (preferred) {
        resumeTerminal = preferred;
      } else if (legacy) {
        resumeTerminal = legacy;
        appendLog(`DEPRECATION: config key "resume-terminal" is deprecated — rename to "preferred-terminal" in global-config.json.`);
        log(`DEPRECATION: config key "resume-terminal" is deprecated — rename to "preferred-terminal" in global-config.json.`);
      }
    }
  } catch {}

  function terminalBinaryExists(terminal) {
    if (terminal === 'git-bash') {
      return fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe');
    }
    const result = require('child_process').spawnSync('where.exe', [terminal === 'powershell' ? 'powershell.exe' : terminal === 'cmd' ? 'cmd.exe' : terminal === 'wt' ? 'wt.exe' : terminal], { encoding: 'utf8' });
    return result.status === 0;
  }

  // ---------- Per-job spawn: visible terminal if binary exists, else detached headless ----------
  for (const job of jobs) {
    const runAgentPath = path.resolve(HARNESS, 'src', 'run-agent.js');
    const logFile = path.resolve(STATE_DIR, `resume-${job.topic}.log`);
    appendLog(`Spawning resume for topic="${job.topic}" terminal="${resumeTerminal}" logFile=${logFile}`);

    const nodeCmd = `"${process.execPath}" "${runAgentPath}" ${job.topic} continue`;
    let child;

    if (resumeTerminal !== 'none' && terminalBinaryExists(resumeTerminal)) {
      let startCmd;
      if (resumeTerminal === 'git-bash') {
        const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
        const innerCmd = `${nodeCmd} >>"${logFile}" 2>&1`;
        startCmd = `start "" "${bash}" -c "${innerCmd.replace(/"/g, '\\"')}"`;
      } else if (resumeTerminal === 'cmd') {
        startCmd = `start cmd /k "${nodeCmd} >>"${logFile}" 2>&1"`;
      } else if (resumeTerminal === 'powershell') {
        startCmd = `start powershell -NoExit -Command "& {${nodeCmd} *>> '${logFile}'}"`;
      } else if (resumeTerminal === 'wt') {
        startCmd = `start wt -d "${ROOT}" cmd /k "${nodeCmd} >>"${logFile}" 2>&1"`;
      }
      if (startCmd) {
        child = spawn('cmd.exe', ['/c', startCmd], { detached: true, stdio: 'ignore', cwd: ROOT });
        child.unref();
        appendLog(`Spawned visible terminal (${resumeTerminal}) pid=${child.pid} for topic="${job.topic}"`);
        log(`Spawned visible ${resumeTerminal} terminal for "${job.topic}". Log: ${path.relative(ROOT, logFile)}`);
        continue;
      }
    }

    if (resumeTerminal !== 'none' && !terminalBinaryExists(resumeTerminal)) {
      appendLog(`Terminal "${resumeTerminal}" not found — falling back to headless spawn for topic="${job.topic}"`);
      log(`Terminal "${resumeTerminal}" not found — falling back to headless spawn for "${job.topic}".`);
    }

    const out = fs.openSync(logFile, 'a');
    child = spawn(process.execPath, [runAgentPath, job.topic, 'continue'], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    appendLog(`Spawned headless pid=${child.pid} for topic="${job.topic}"`);
    log(`Spawned resume for "${job.topic}" (pid ${child.pid}). Log: ${path.relative(ROOT, logFile)}`);
  }

  appendLog('Done.');
} catch (err) {
  appendLog('Unhandled fatal error', err);
  console.error('[auto-resume.js] Fatal error:', err.message);
  process.exit(1);
}
