'use strict';

const fs = require('fs');

/**
 * Atomically write JSON to `targetPath`:
 *  1. Serialize (if object) or accept pre-serialized string.
 *  2. Round-trip parse to validate well-formed JSON.
 *  3. Optional schemaCheck(parsed) — throws if structurally invalid.
 *  4. Write to `<targetPath>.tmp`.
 *  5. Rotate existing target -> `<targetPath>.bak` (best-effort).
 *  6. Rename `.tmp` -> target (atomic on same-filesystem).
 *
 * Original file left intact on any failure. Throws on validation failure.
 *
 * @param {string} targetPath
 * @param {string|object} content
 * @param {function} [schemaCheck]  fn(parsed) throws if invalid
 */
function safeJsonWrite(targetPath, content, schemaCheck) {
  const str = (typeof content === 'string')
    ? content
    : JSON.stringify(JSON.parse(JSON.stringify(content)), null, 2) + '\n';

  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch (e) {
    throw new Error(`[safe-json-write] JSON validation failed for ${targetPath}: ${e.message}`);
  }

  if (typeof schemaCheck === 'function') {
    schemaCheck(parsed);
  }

  const tmpPath = targetPath + '.tmp';

  try {
    fs.writeFileSync(tmpPath, str, 'utf8');
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`[safe-json-write] Failed to write tmp ${tmpPath}: ${e.message}`);
  }

  try {
    if (fs.existsSync(targetPath)) {
      fs.copyFileSync(targetPath, targetPath + '.bak');
    }
  } catch {}

  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`[safe-json-write] Rename ${tmpPath} -> ${targetPath} failed: ${e.message}`);
  }
}

/**
 * Atomically write a plain text string to `targetPath`. Mirrors the safe pattern
 * used by safeJsonWrite (write tmp -> rename) but skips JSON validation. Why:
 * tiny pointer files like `.last-topic` need crash-safe writes — a plain
 * `fs.writeFileSync` interrupted mid-call can leave the file truncated to 0
 * bytes, after which `hrun` proceeds with an empty topic. Same-FS rename is
 * atomic, so the file is always either the old value or the new value.
 */
// Retry helper for `fs.renameSync` over an existing target. On Windows,
// rapid sequential writes can hit transient EPERM/EBUSY/EACCES from antivirus
// or the search indexer holding a brief read handle on the destination — the
// failure is intermittent and clears within milliseconds. Fall back to a
// copy+unlink swap on the final attempt so the new content still lands.
// Why: prevents a regression vs. the previous `fs.writeFileSync` path where
// `.last-topic` writes never failed; without this retry, `hset`/`hrun` would
// crash on Windows hosts under indexer/AV pressure.
function _renameWithRetry(tmpPath, targetPath) {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
  const maxAttempts = 10;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (e) {
      lastErr = e;
      if (!transient.has(e.code)) throw e;
      // Spin-wait briefly (2..20ms) — busy loop avoids needing async here.
      const until = Date.now() + (2 + attempt * 2);
      while (Date.now() < until) { /* spin */ }
    }
  }
  // Final fallback: copy + unlink. Not atomic, but preserves the new content
  // when rename is permanently blocked by an external handle on the target.
  try {
    fs.copyFileSync(tmpPath, targetPath);
    try { fs.unlinkSync(tmpPath); } catch {}
    return;
  } catch (e2) {
    throw lastErr || e2;
  }
}

function atomicWriteText(targetPath, text) {
  const str = String(text);
  const tmpPath = targetPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, str, 'utf8');
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`[atomic-write-text] Failed to write tmp ${tmpPath}: ${e.message}`);
  }
  // Rename-with-retry handles Windows transient EPERM/EBUSY from indexer/AV
  // holding a momentary handle on the destination after a prior write.
  try {
    _renameWithRetry(tmpPath, targetPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`[atomic-write-text] Rename ${tmpPath} -> ${targetPath} failed: ${e.message}`);
  }
}

module.exports = { safeJsonWrite, atomicWriteText };
