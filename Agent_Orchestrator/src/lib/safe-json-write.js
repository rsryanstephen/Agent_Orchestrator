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

module.exports = { safeJsonWrite };
