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
  stream('Usage: node run-parallel.js [[<id>-]<cmd> ...]');
  stream('  Bare `node run-parallel.js`           → defaults to `all` on the last-touched topic');
  stream('  Bare `node run-parallel.js 1`         → defaults to `1-all`');
  stream('Examples:');
  stream('  node run-parallel.js 1-c              # coding on topic id 1');
  stream('  node run-parallel.js 1-caf 2-f        # parallel: caf on 1, fix on 2');
  stream('  node run-parallel.js caf              # last-touched topic, code-assess-fix');
  stream('');
  stream('If using alias functions:');
  stream('  hrun                                  # → all (last-touched topic)');
  stream('  hrun 1                                # → 1-all');
  stream('  hrun 1-c                              # coding on topic id 1');
  stream('  hrun 1-caf 2-f                        # parallel');
  stream('  hrun caf                              # last-touched topic, code-assess-fix');
}

// Flush unsaved IDE/editor buffers the moment `hrun` is typed -> any file
// edited in VS Code/Cursor/etc just before submitting the command is written
// to disk BEFORE downstream agents read it. Best-effort (silent on failure).
try { require('./editor-buffer-flush').flushEditorBuffers(); } catch {}

// ---------- Token parsing: normalize CLI args -> {token,id,cmd} job descriptors ----------
let tokens = process.argv.slice(2);
if (tokens.length === 0) tokens = ['all'];

const runAgent = path.join(__dirname, 'run-agent.js');
const jobs = [];

for (const rawToken of tokens) {
  let token = rawToken;
  // Bare id (e.g. "1") → "<id>-all"
  if (/^\d+$/.test(token)) token = `${token}-all`;
  const m = token.match(/^(?:(\d+)-)?([a-z]+)$/);
  if (!m) {
    console.error(`run-parallel: invalid token '${rawToken}' (expected '<id>-<cmd>', '<cmd>', or bare '<id>')`);
    printUsage();
    process.exit(1);
  }
  const [, id, cmdKey] = m;
  const cmd = CMD_MAP[cmdKey];
  if (!cmd) {
    console.error(`run-parallel: unknown command '${cmdKey}' in token '${rawToken}'`);
    printUsage();
    process.exit(1);
  }
  jobs.push({ token, id: id || null, cmd });
}

function argsFor(job) {
  return job.id ? [runAgent, job.id, job.cmd] : [runAgent, job.cmd];
}

// ---------- Dispatch: single job inherits stdio; multi-job goes through broker ----------
if (jobs.length === 1) {
  const job = jobs[0];
  const child = spawn(process.execPath, argsFor(job), { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
} else {
  // Multi-job: route clarifying-question prompts through the broker so that
  // parallel children share one CLI stdin via IPC (FIFO queue).
  const { createBroker } = require('./parallel-broker');
  const broker = createBroker({ runAgentPath: runAgent, jobs, env: process.env });
  broker.start();
}
