'use strict';

/**
 * Single-CLI arbitration for clarifying-question prompts across parallel agents.
 *
 * FIFO lock spans topics — only one agent at a time may render clarifying
 * questions to the (single) interactive CLI channel. Other agents park until
 * the current holder releases.
 *
 * Lock-ordering rule (deadlock avoidance):
 *   1. Acquire clarifier-lock FIRST.
 *   2. THEN acquire any shared-file locks.
 *   Equivalently: release all file locks before parking on the clarifier.
 */

let holder = null;          // current tag string or null
const waiters = [];         // {tag, resolve}

function _drain() {
  if (holder !== null) return;
  const w = waiters.shift();
  if (!w) return;
  holder = w.tag;
  w.resolve(_makeRelease(w.tag));
}

function _makeRelease(tag) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    if (holder === tag) holder = null;
    _drain();
  };
}

/**
 * @param {string} tag - "topic/slug" label printed alongside the prompt so the
 *                       user knows which parallel task is asking.
 * @returns {Promise<Function>} release()
 */
function acquire(tag) {
  if (holder === null) {
    holder = tag;
    return Promise.resolve(_makeRelease(tag));
  }
  return new Promise(resolve => waiters.push({ tag, resolve }));
}

function currentHolder() { return holder; }
function waitingCount() { return waiters.length; }
function _resetForTests() { holder = null; waiters.length = 0; }

module.exports = { acquire, currentHolder, waitingCount, _resetForTests };
