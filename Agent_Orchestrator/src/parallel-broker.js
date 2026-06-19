'use strict';

// Parallel clarifying-question broker. Owns the single CLI stdin while
// `run-parallel.js` has >1 child. Children launched with `ipc` notify the
// parent of pending clarifying questions; the broker serialises them into a
// FIFO queue, prompts the user for the head item, and routes answers back to
// the originating child via `child.send({type:'answer', text})`.

const readline = require('readline');
const { spawn } = require('child_process');
const path = require('path');
const { createReplyAccumulator } = require('./reply-parser');
const { playChime } = require('./sound');

// Factory: per-broker instance owns FIFO question queue, active prompt state,
// child handles, and stdin raw-mode arming. Returns { start, ...test hooks }.
function createBroker({ runAgentPath, jobs, env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, chime = playChime, log: customLog } = {}) {
  const log = customLog || ((msg) => stdout.write(`[broker] ${msg}\n`));
  const pendingQuestions = []; // FIFO: {token, topic, role, questionsText, child}
  const childrenByToken = new Map();
  const exitCodes = new Map();
  let active = null; // currently-prompting queue entry
  let rl = null;
  let rawModeArmed = false;
  let stdinKeyListener = null;

  function prefixWrite(stream, label, chunk) {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) stream.write(`${label} ${line}\n`);
    }
  }

  // ---------- Child lifecycle: spawn with IPC, prefix-fan output, route messages, track exits ----------
  function spawnChild(job) {
    const args = job.id ? [runAgentPath, job.id, job.cmd] : [runAgentPath, job.cmd];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
      windowsHide: true,
    });
    const label = `[${job.token}]`;
    child.stdout.on('data', (c) => prefixWrite(stdout, label, c));
    child.stderr.on('data', (c) => prefixWrite(stderr, label, c));
    child.on('message', (m) => onChildMessage(child, job, m));
    child.on('exit', (code) => onChildExit(job, code));
    childrenByToken.set(job.token, { job, child });
    return child;
  }

  function onChildMessage(child, job, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'question') {
      enqueueQuestion({
        token: job.token,
        topic: msg.topic || job.token,
        role: msg.role || 'unknown',
        questionsText: msg.questionsText || '',
        child,
        job,
      });
    }
  }

  function onChildExit(job, code) {
    exitCodes.set(job.token, code === null ? 1 : code);
    stdout.write(`[${job.token}] exited with code ${code}\n`);
    // Drop any queued questions for this child.
    for (let i = pendingQuestions.length - 1; i >= 0; i--) {
      if (pendingQuestions[i].token === job.token) {
        stderr.write(`[${job.token}] child exited while awaiting answer — dropping question\n`);
        pendingQuestions.splice(i, 1);
      }
    }
    if (active && active.token === job.token) {
      stderr.write(`[${job.token}] child exited while awaiting answer — dropping question\n`);
      teardownActivePrompt();
      active = null;
      tryDispatchNext();
    }
    if (childrenByToken.size > 0) childrenByToken.delete(job.token);
    if (exitCodes.size >= jobs.length) {
      finalize();
    }
  }

  // ---------- Question queue: FIFO + chime + press-any-key reveal arming ----------
  function enqueueQuestion(entry) {
    pendingQuestions.push(entry);
    const total = pendingQuestions.length + (active ? 1 : 0);
    if (!active) {
      // First queued item → chime + announce.
      chime();
      stdout.write(`\n[${entry.token}] (${entry.topic}) clarifying questions ready — press any key to view (queue: ${total})\n`);
      armKeystrokeReveal();
    } else {
      stdout.write(`\n${entry.topic}: [B] queued: ${pendingQuestions.length} pending questions\n`);
    }
  }

  function armKeystrokeReveal() {
    if (rawModeArmed) return;
    if (!stdin.isTTY) {
      // Non-TTY fallback: reveal immediately.
      revealNext();
      return;
    }
    try { stdin.setRawMode(true); } catch {}
    rawModeArmed = true;
    stdin.resume();
    stdinKeyListener = () => {
      try { stdin.setRawMode(false); } catch {}
      rawModeArmed = false;
      stdin.removeListener('data', stdinKeyListener);
      stdinKeyListener = null;
      revealNext();
    };
    stdin.on('data', stdinKeyListener);
  }

  // ---------- Active-prompt UI: print head question, accumulate multi-line reply, submit ----------
  function revealNext() {
    if (active) return;
    const head = pendingQuestions.shift();
    if (!head) return;
    active = head;
    stdout.write(`\n──── [${head.token}] (${head.topic}) clarifying questions ────\n`);
    if (head.questionsText) stdout.write(head.questionsText + '\n');
    stdout.write(`──── end ────\n`);
    stdout.write(`Type :submit (or :s) to send; ENTER twice on consecutive blank lines also submits.\n> `);
    const acc = createReplyAccumulator();
    active.acc = acc;
    rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    rl.on('line', (line) => {
      if (acc.onLine(line)) {
        submitActive(acc.getBuffer());
      } else if (pendingQuestions.length > 0) {
        // Append unobtrusive queue note (no redraw).
        stdout.write(`(queue: ${pendingQuestions.length} pending)\n`);
      }
    });
  }

  function submitActive(text) {
    if (!active) return;
    try {
      active.child.send({ type: 'answer', text });
    } catch (e) {
      stderr.write(`[${active.token}] failed to send answer to child: ${e.message}\n`);
    }
    teardownActivePrompt();
    active = null;
    tryDispatchNext();
  }

  function teardownActivePrompt() {
    if (rl) {
      try { rl.removeAllListeners('line'); rl.close(); } catch {}
      rl = null;
    }
  }

  function tryDispatchNext() {
    if (pendingQuestions.length === 0) return;
    const head = pendingQuestions[0];
    stdout.write(`\n[${head.token}] (${head.topic}) next clarifying questions queued — press any key to view (queue: ${pendingQuestions.length})\n`);
    armKeystrokeReveal();
  }

  // ---------- Shutdown: aggregate exit codes, exit non-zero if any child failed ----------
  function finalize() {
    const codes = jobs.map(j => exitCodes.get(j.token));
    const failed = codes.filter(c => c !== 0).length;
    stdout.write(`[run-parallel] All done. ${jobs.length - failed} succeeded, ${failed} failed.\n`);
    process.exit(failed === 0 ? 0 : 1);
  }

  // ---------- Entry: provider-capability gate -> parallel spawn or sequential fallback ----------
  function start() {
    // Check provider capability — if subAgents=false, run sequentially instead of parallel.
    let runSequential = false;
    try {
      const { getProvider } = require('./lib/providers/registry');
      const provider = getProvider();
      if (!provider.capabilities.subAgents) {
        runSequential = true;
        stdout.write(`[WARN] Provider "${provider.id}" does not support sub-agents (capabilities.subAgents=false). Running ${jobs.length} job(s) sequentially.\n`);
      }
    } catch { /* registry unavailable — keep parallel behaviour */ }

    if (runSequential) {
      // Sequential emulation: spawn next child only after previous exits.
      let idx = 0;
      function spawnNextSequential() {
        if (idx >= jobs.length) return;
        const j = jobs[idx++];
        const entry = childrenByToken.get(j.token);
        if (entry) return; // already spawned (shouldn't happen)
        const child = spawnChild(j);
        child.once('exit', () => spawnNextSequential());
      }
      process.on('SIGINT', () => {
        // Removed SIGINT teardown chime to cut audio spam and stay consistent
        // with the parallel SIGINT branch (which never chimed); the only
        // remaining broker chime is the clarifying-question cue in enqueueQuestion.
        stderr.write('[broker] SIGINT — forwarding SIGTERM to children\n');
        for (const { child } of childrenByToken.values()) {
          try { child.kill('SIGTERM'); } catch {}
        }
      });
      spawnNextSequential();
      return;
    }

    stdout.write(`[run-parallel] Launching ${jobs.length} job(s) via broker: ${jobs.map(j => j.token).join(', ')}\n`);
    for (const j of jobs) spawnChild(j);
    process.on('SIGINT', () => {
      stderr.write('[broker] SIGINT — forwarding SIGTERM to children\n');
      for (const { child } of childrenByToken.values()) {
        try { child.kill('SIGTERM'); } catch {}
      }
    });
  }

  return {
    start,
    // exposed for tests
    _enqueue: enqueueQuestion,
    _state: { pendingQuestions, childrenByToken, get active() { return active; } },
    _submitActive: submitActive,
    _onChildExit: onChildExit,
  };
}

module.exports = { createBroker };
