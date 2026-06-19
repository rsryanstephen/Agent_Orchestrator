#!/usr/bin/env node
/**
 Unified harness dispatcher. Accepts one or more `<id>-<cmd>` (or bare `<cmd>`)
 tokens and routes to run-agent.js.

 Single token:    spawned with stdio: 'inherit' (CLI pause for clarifying
                  questions works as expected; no prefixed output).
 Multiple tokens: each token is spawned concurrently as a Node child process
                  (bypassing the Git Bash + winpty SIGTTOU issue) and its
                  stdout/stderr is line-prefixed with `[<token>]`.

 Token formats:
   <id>-<cmd>   — explicit topic id + command (e.g. 1-c, 2-caf)
   <cmd>        — command only, runs on the last-touched topic (e.g. caf)

 Command shorthand:
   p    → planning           f     → fix             pc   → plan-code
   c    → coding             af    → assess-fix      caf  → code-assess-fix
   a    → assessment         all   → all             pcaf → all
   cont → continue
**/

'use strict';

const path = require('path');
const { spawn } = require('child_process');

// ---------- Command-shorthand -> canonical role name (used to translate CLI tokens) ----------
const CMD_MAP = {
  p:    'planning',
  c:    'coding',
  a:    'assessment',
  f:    'fix',
  af:   'assess-fix',
  pc:   'plan-code',
  caf:  'code-assess-fix',
  all:  'all',
  pcaf: 'all',
  cont: 'continue',
};

// ---------- Usage banner (stderr unless caller wants stdout) ----------
function printUsage(stream = console.error) {
  stream('Usage: node run-parallel.js [[<id|topic>-]<cmd> ...]');
  stream('  Bare `node run-parallel.js`           → last-touched topic, pipeline from prompt-file header / promptQueue.defaultPipeline');
  stream('  Bare `node run-parallel.js 1`         → topic id 1, pipeline from header / default');
  stream('  Bare `node run-parallel.js <topic>`   → named topic, pipeline from header / default');
  stream('Examples:');
  stream('  node run-parallel.js 1-c              # coding on topic id 1 (explicit pipeline wins)');
  stream('  node run-parallel.js 1-caf 2-f        # parallel: caf on 1, fix on 2');
  stream('  node run-parallel.js caf              # last-touched topic, code-assess-fix');
  stream('');
  stream('If using alias functions:');
  stream('  hrun                                  # → last-touched topic, header/default pipeline');
  stream('  hrun 1                                # → topic id 1, header/default pipeline');
  stream('  hrun 1-c                              # coding on topic id 1 (explicit)');
  stream('  hrun 1-caf 2-f                        # parallel');
  stream('  hrun caf                              # last-touched topic, code-assess-fix');
}

// run-agent.js path — module-level so `argsFor` and the dispatch can share it.
const runAgent = path.join(__dirname, 'run-agent.js');

function argsFor(job) {
  // Topic-only job (no cmd): spawn run-agent with just the topic/id (or nothing,
  // for bare `hrun`) so run-agent defers the pipeline to the prompt-file header
  // or promptQueue.defaultPipeline instead of being forced to a CLI role.
  if (!job.cmd) return job.id ? [runAgent, job.id] : [runAgent];
  return job.id ? [runAgent, job.id, job.cmd] : [runAgent, job.cmd];
}

// Bridge `*-sound-file` config overrides into `AMA_SOUND_*` env vars BEFORE
// spawning the broker. The broker runs in this process tree with no topic
// config in scope, so without this its `playClarifyingSound` chime ignored a
// user's custom tone (overrides previously applied in-process only). We resolve
// from global-config (the only well-defined source for a shared broker that may
// front multiple topics); per-topic overrides remain in-process via run-agent.
// Best-effort + non-fatal: a missing/corrupt config just leaves defaults.
//
// Params injected (config + env) rather than closed-over so the bridge is
// behaviourally unit-testable without disturbing real global config or the real
// process.env: a test passes a fake config object and a throwaway env target and
// asserts the resulting mappings + the `.wav`-leak guard directly. Production
// callers omit both args and get the global-config load + live process.env.
function exportSoundOverridesToEnv(config, env = process.env) {
  const KEY_TO_ENV = {
    'clarifying-sound-file': 'AMA_SOUND_CLARIFYING',
    'queue-fetch-sound-file': 'AMA_SOUND_QUEUE_FETCH',
    'completion-sound-file': 'AMA_SOUND_COMPLETION',
    'token-limit-sound-file': 'AMA_SOUND_TOKEN_LIMIT',
    'error-sound-file': 'AMA_SOUND_ERROR',
  };
  try {
    let global = config;
    if (global === undefined) {
      const configUtils = require('./config-utils');
      global = configUtils.loadConfig(configUtils.globalConfigPath());
    }
    for (const [key, envName] of Object.entries(KEY_TO_ENV)) {
      const v = global && global[key];
      // Forward any non-empty `.wav` path override to the broker's `_playEvent`;
      // non-string/blank values are skipped (default `.wav` applies).
      if (typeof v === 'string' && v.trim()) {
        env[envName] = v.trim();
      }
    }
    // Gate the broker's clarifying tone: when `auto-answer-clarifying-questions-and-submit`
    // is on the harness answers+submits without pausing, so the broker's
    // "your input is needed" chime would be spurious. Bridged as a flag the
    // broker-side `playClarifyingSound` honors.
    if (global && global['auto-answer-clarifying-questions-and-submit']) {
      env.AMA_SUPPRESS_CLARIFYING = '1';
    }
  } catch {}
}

// ---------- Imperative CLI bootstrap (token parse + dispatch) ----------
// Wrapped in main() behind a `require.main === module` guard so the module can be
// `require()`d from tests to exercise the exported pure helpers (e.g. the sound
// env bridge) WITHOUT parsing the test runner's argv or spawning a broker.
function main() {
  // Flush unsaved IDE/editor buffers the moment `hrun` is typed -> any file
  // edited in VS Code/Cursor/etc just before submitting the command is written
  // to disk BEFORE downstream agents read it. Best-effort (silent on failure).
  try { require('./editor-buffer-flush').flushEditorBuffers(); } catch {}

  // Token parsing: normalize CLI args -> {token,id,cmd} job descriptors.
  // No tokens → one topic-only job (no id, no cmd): bare `hrun` runs on the
  // last-touched topic and defers the pipeline to the prompt-file header /
  // promptQueue.defaultPipeline (was previously forced to `all`).
  const tokens = process.argv.slice(2);
  const jobs = [];
  if (tokens.length === 0) {
    jobs.push({ token: '(last-topic)', id: null, cmd: null });
  }
  for (const rawToken of tokens) {
    const token = rawToken;
    // Form `<prefix>-<cmd>` with a KNOWN command shorthand: explicit pipeline on
    // topic id OR topic name `<prefix>` (widened from digits-only to accept
    // named topics like `claude_harness-caf`).
    const dashMatch = token.match(/^([A-Za-z0-9_]+)-([a-z]+)$/);
    if (dashMatch && CMD_MAP[dashMatch[2]]) {
      jobs.push({ token, id: dashMatch[1], cmd: CMD_MAP[dashMatch[2]] });
      continue;
    }
    // Bare known shorthand (e.g. `caf`): command on the last-touched topic.
    if (CMD_MAP[token]) {
      jobs.push({ token, id: null, cmd: CMD_MAP[token] });
      continue;
    }
    // Bare id (`3`) or topic name (`claude_harness`) that is NOT a shorthand:
    // topic-only job. Spawn run-agent with the topic alone and let it pick the
    // pipeline from the prompt-file header / promptQueue.defaultPipeline.
    if (/^[A-Za-z0-9_]+$/.test(token)) {
      jobs.push({ token, id: token, cmd: null });
      continue;
    }
    console.error(`run-parallel: invalid token '${rawToken}' (expected '<id>-<cmd>', '<topic>-<cmd>', '<cmd>', bare '<id>', or bare '<topic>')`);
    printUsage();
    process.exit(1);
  }

  // Dispatch: single job inherits stdio; multi-job goes through broker.
  if (jobs.length === 1) {
    const job = jobs[0];
    const child = spawn(process.execPath, argsFor(job), { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => process.exit(code === null ? 1 : code));
  } else {
    // Multi-job: route clarifying-question prompts through the broker so that
    // parallel children share one CLI stdin via IPC (FIFO queue).
    // Populate AMA_SOUND_* env so the broker's clarifying chime honors a custom
    // `*-sound-file` override (children inherit this env too).
    exportSoundOverridesToEnv();
    const { createBroker } = require('./parallel-broker');
    const broker = createBroker({ runAgentPath: runAgent, jobs, env: process.env });
    broker.start();
  }
}

// Export the pure helper for behavioural tests; run the CLI only as entry point.
module.exports = { exportSoundOverridesToEnv, argsFor };
if (require.main === module) main();
