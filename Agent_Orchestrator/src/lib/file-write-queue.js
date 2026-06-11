'use strict';

/**
 * Serialised per-path write queue. Two parallel agents may not touch the same
 * absolute file path concurrently — writes (and edits to overlapping source
 * files) are funneled through a per-path FIFO.
 *
 * Lock-ordering rule (see clarifier-lock): file locks acquired AFTER the
 * clarifier-lock and released BEFORE parking on the clarifier.
 */

const path = require('path');

const queues = new Map(); // absolutePath -> Promise chain tail

function _key(p) {
  // Normalise so case-insensitive Windows paths collapse to one slot.
  return path.resolve(p).toLowerCase();
}

/**
 * Run `task` (returning a Promise) exclusively for the given absolute file
 * path. Tasks for the same path run strictly in FIFO order; tasks for
 * different paths run concurrently.
 *
 * @template T
 * @param {string} absPath
 * @param {() => Promise<T>|T} task
 * @returns {Promise<T>}
 */
function runExclusive(absPath, task) {
  const k = _key(absPath);
  const prev = queues.get(k) || Promise.resolve();
  const next = prev.then(() => Promise.resolve().then(task));
  // Keep the chain alive even on rejection so subsequent tasks still run.
  queues.set(k, next.catch(() => {}));
  return next;
}

function activePathCount() { return queues.size; }
function _resetForTests() { queues.clear(); }

module.exports = { runExclusive, activePathCount, _resetForTests };
