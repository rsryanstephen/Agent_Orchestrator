'use strict';

// =========================================================================
// Last-topic guard: validates `.last-topic` against the topic_files dir
// before any caller acts on it. Why: a stale pointer (e.g. an e2e stub
// topic dir cleaned up after the test) would otherwise dispatch into a
// non-existent topic and crash `hrun`. Fallback order:
//   1) configured default ("claude_harness") when its dir exists
//   2) most-recently-modified valid topic dir (fs.stat mtime)
//   3) first alphabetical topic dir
// The named default is preferred first so a transient e2e stub dir (which
// will momentarily have the newest mtime) cannot win over the canonical
// user topic. On recovery the file is rewritten atomically so subsequent
// reads agree.
// =========================================================================

const fs = require('fs');
const path = require('path');
const { atomicWriteText } = require('./safe-json-write');

function _safeReaddirDirs(topicsDir) {
  try {
    return fs.readdirSync(topicsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

function _pickFallback(topicsDir, fallback) {
  // Enumerate valid topic dirs. Prefer the named default first so a
  // transient e2e stub topic (newest mtime, but cleaned up later) cannot
  // displace the canonical user topic. Falls back to mtime-newest, then
  // alphabetical, when the named default is absent.
  const names = _safeReaddirDirs(topicsDir);
  if (names.length === 0) return null;
  if (fallback && names.includes(fallback)) {
    try {
      if (fs.statSync(path.join(topicsDir, fallback)).isDirectory()) return fallback;
    } catch {}
  }
  let newest = null;
  let newestMtime = -Infinity;
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(topicsDir, name));
      if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newest = name; }
    } catch {}
  }
  if (newest) return newest;
  return [...names].sort()[0] || null;
}

// Resolve `.last-topic` against the on-disk topic dirs. Returns
// { topic, recovered, reason }. Rewrites the pointer file when recovered.
function resolveLastTopic({ topicsDir, lastTopicPath, fallback }) {
  let raw = '';
  let existed = false;
  try {
    if (fs.existsSync(lastTopicPath)) {
      existed = true;
      raw = (fs.readFileSync(lastTopicPath, 'utf8') || '').trim();
    }
  } catch {}

  const dirExists = (name) => {
    if (!name) return false;
    try { return fs.statSync(path.join(topicsDir, name)).isDirectory(); }
    catch { return false; }
  };

  if (raw && dirExists(raw)) {
    return { topic: raw, recovered: false, reason: null };
  }

  const reason = !existed
    ? 'missing'
    : (!raw ? 'empty' : `stale (no dir for "${raw}")`);

  const picked = _pickFallback(topicsDir, fallback || 'claude_harness');
  if (!picked) {
    return { topic: null, recovered: false, reason: `${reason}; no fallback topic dirs found` };
  }

  try { atomicWriteText(lastTopicPath, picked); } catch {}
  return { topic: picked, recovered: true, reason };
}

module.exports = { resolveLastTopic };
