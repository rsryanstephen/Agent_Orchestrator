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

let _shared = null;

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

module.exports = { createSemaphore, getSemaphore, _resetForTests };
