'use strict';

/**
 * Cross-topic async semaphore. Process-wide slot counter so the
 * `max-parallel-agents` cap is global across topics.
 *
 * Tag convention: pass `"<topic>/<slug>"` so the CLI notice surfaces the
 * topic name (not just the per-task slug) — see QA bullet 3.
 *
 * Usage:
 *   const sem = getSemaphore(N);
 *   const release = await sem.acquire('agent_orchestrator/parallel-impl');
 *   try { ... } finally { release(); }
 */

const fs = require('fs');
const path = require('path');

let _shared = null;

// ── Cross-process counting semaphore ────────────────────────────────────────
// The in-process semaphore below only caps holders WITHIN one Node process.
// The `max-parallel-agents` key is described as a cap "across all topics" —
// but the harness fans topics out into SEPARATE child processes, so a
// per-process singleton never enforces the global cap. This file-backed
// semaphore fixes that: every acquirer (any process) contends on the same
// `slotsDir`. A held slot is a `<pid>.<n>.slot` file; liveness is proven by
// `process.kill(pid, 0)`, so a crashed owner's slot is reaped on the next
// count. Mutations to the slots dir are serialised by a PID-reap lock file
// (same pattern proven in parallel-batch.js `_acquireHistoryLock`).

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _acquireDirLock(slotsDir) {
  const lockPath = slotsDir + '.lock';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Reap a stale lock whose owner PID is gone, then retry.
      try {
        const ownerPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        try { process.kill(ownerPid, 0); } catch { try { fs.unlinkSync(lockPath); } catch {} continue; }
      } catch {}
      // Brief synchronous spin — lock is held for microseconds (a readdir + write).
      const end = Date.now() + 25;
      while (Date.now() < end) { /* spin */ }
    }
  }
  return null; // timed out — proceed unlocked rather than deadlock
}
function _releaseDirLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch {}
}

// Count slots whose owner process is still alive; unlink (reap) dead ones.
// Caller must hold the dir lock.
function _liveSlotCount(slotsDir) {
  let names;
  try { names = fs.readdirSync(slotsDir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.slot')) continue;
    const pid = parseInt(name.split('.')[0], 10);
    if (!pid) continue;
    try { process.kill(pid, 0); n++; }
    catch { try { fs.unlinkSync(path.join(slotsDir, name)); } catch {} }
  }
  return n;
}

// Build a cross-process semaphore rooted at `slotsDir`. `acquire` resolves with
// an idempotent `release` once a live-slot count below `cap` is observed.
function createCrossProcessSemaphore(max, slotsDir) {
  const cap = Math.max(1, Number(max) || 1);
  try { fs.mkdirSync(slotsDir, { recursive: true }); } catch {}
  let _ctr = 0;

  async function acquire(tag) {
    let warned = false;
    while (true) {
      const lock = _acquireDirLock(slotsDir);
      try {
        if (_liveSlotCount(slotsDir) < cap) {
          const slotPath = path.join(slotsDir, `${process.pid}.${_ctr++}.slot`);
          try { fs.writeFileSync(slotPath, String(tag || ''), 'utf8'); } catch {}
          let released = false;
          return function release() {
            if (released) return;
            released = true;
            try { fs.unlinkSync(slotPath); } catch {}
          };
        }
      } finally { _releaseDirLock(lock); }
      if (!warned && typeof process !== 'undefined' && process.stderr && tag) {
        warned = true;
        process.stderr.write(`queue for "${tag}" capped at ${cap} parallel (cross-process) — waiting\n`);
      }
      await _sleep(50);
    }
  }

  return {
    acquire,
    capacity: cap,
    get inUse() { const l = _acquireDirLock(slotsDir); try { return _liveSlotCount(slotsDir); } finally { _releaseDirLock(l); } },
    // Cross-process waiters are not centrally tracked; expose 0 so runBatch's
    // optional onSlotBlocked notice stays numeric rather than NaN.
    get waiting() { return 0; },
  };
}

function createSemaphore(max) {
  const cap = Math.max(1, Number(max) || 1);
  let inUse = 0;
  const waiters = []; // {tag, resolve}

  function _drain() {
    while (inUse < cap && waiters.length) {
      const w = waiters.shift();
      inUse++;
      w.resolve(_makeRelease());
    }
  }

  function _makeRelease() {
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      inUse = Math.max(0, inUse - 1);
      _drain();
    };
  }

  function acquire(tag) {
    if (inUse < cap) {
      inUse++;
      return Promise.resolve(_makeRelease());
    }
    if (typeof process !== 'undefined' && process.stderr && tag) {
      const waiting = waiters.length + 1;
      // `tag` is expected to be `"<topic>/<slug>"`. We do NOT prefix the word
      // "topic" so the message reads cleanly whether the caller passed only a
      // topic, only a slug, or the combined form.
      process.stderr.write(
        `queue for "${tag}" capped at ${cap} parallel — ${waiting} items waiting\n`
      );
    }
    return new Promise(resolve => waiters.push({ tag, resolve }));
  }

  return {
    acquire,
    get inUse() { return inUse; },
    get waiting() { return waiters.length; },
    get capacity() { return cap; },
  };
}

/**
 * Process-wide shared semaphore. Distinct from `createSemaphore` which always
 * makes a fresh instance.
 *
 * If called twice with different `max` values, the FIRST cap wins and a
 * one-time stderr warning is emitted — silently re-using the old cap caused
 * second-topic surprises (QA gap 5). To deliberately resize, call
 * `_resetForTests()` first or pass `{ resize: true }`.
 */
let _resizeWarned = false;
function getSemaphore(max, opts) {
  const want = Math.max(1, Number(max) || 1);
  if (_shared) {
    if (_shared.capacity !== want) {
      if (opts && opts.resize) {
        _shared = createSemaphore(want);
        return _shared;
      }
      if (!_resizeWarned && typeof process !== 'undefined' && process.stderr) {
        _resizeWarned = true;
        process.stderr.write(
          `[parallel-semaphore] shared cap already set to ${_shared.capacity}; ignoring new cap ${want}. Pass {resize:true} to override.\n`
        );
      }
    }
    return _shared;
  }
  _shared = createSemaphore(want);
  return _shared;
}

function _resetForTests() { _shared = null; _resizeWarned = false; }

module.exports = { createSemaphore, getSemaphore, createCrossProcessSemaphore, _resetForTests };
