#!/usr/bin/env node
'use strict';

/**
 * Prompt-queue support for the AMA harness.
 *
 *   topic_files/<topic>/prompt-queue.md
 *
 * Format:
 *   Optional first non-blank line: header in either form
 *     - `Pipeline: <name|shorthand>`        (e.g. `Pipeline: caf`)
 *     - `<bare-shorthand>`                  (e.g. `pcaf`)
 *   Blocks are separated by a line containing only `---`.
 *   First block applies its header (if any) to itself; subsequent blocks may
 *   carry their own header on their first non-blank line.
 *
 * Missing header → uses `promptQueue.defaultPipeline` (default: `all`).
 *
 * State = the file itself. Dequeue rewrites the file with the head block removed.
 * A sibling lock file `prompt-queue.md.lock` serialises mutations.
 *
 * Shorthand list is sourced from `shell-functions.txt` (`# Shorthand: ...`)
 * so the queue parser and shell aliases share one canonical list.
 *
 * ── DISK IS THE ONLY SOURCE OF TRUTH ─────────────────────────────────────────
 * Every public reader below (`queueLength`, `parseQueue`, `dequeueHead`,
 * `dequeueFirstUnheld`) performs a fresh `fs.readFileSync` per call. There is
 * NO module-level in-memory cache of parsed blocks. This is deliberate: the
 * user may freely edit `prompt-queue.md` in any external editor at any time,
 * and the next call into this module MUST pick up the latest on-disk content.
 *
 * Callers MUST NOT capture a `blocks` / `parsedQueue` snapshot before an
 * `await` boundary and reuse it after — call the module again to re-read.
 * Holding parsed state across phase transitions has been the source of
 * "stale queue drained" bugs in the past.
 */

const fs = require('fs');
const path = require('path');

const HARNESS_DIR = path.join(__dirname, '..');
const SHELL_FUNCTIONS_FILE = path.join(HARNESS_DIR, 'shell-functions.txt');

// Strict: divider must be `---` at column 0. Indented `---` inside the seed's
// HTML example block must NOT be treated as a real divider, else dequeue
// fragments the seed and wipes the `# Prompt Queue` header on drain.
const DIVIDER_RE = /^---\s*$/;
const HEADER_PIPELINE_RE = /^\s*Pipeline\s*:\s*([A-Za-z0-9_-]+)\s*$/i;
const BARE_SHORTHAND_RE = /^\s*([A-Za-z]{1,8})\s*$/;
// Hold marker — `(hold)` on header line OR a hold-variation on the FIRST
// non-blank body line. Case-insensitive. Body-line form accepts wrapping
// punctuation: `hold`, `(hold)`, `[hold]`, `<HOLD>`, etc. Mid-body matches
// are ignored — must be the first non-blank line after the header.
const HOLD_INLINE_RE = /\s*\(hold\)\s*$/i;
const HOLD_LINE_RE = /^\s*[\[(\<]?\s*hold\s*[\]\)\>]?\s*$/i;

// ---------- Shorthand parsing: scrape shell-functions.txt for canonical aliases ----------
function readShorthandList(file = SHELL_FUNCTIONS_FILE) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const m = txt.match(/Shorthand\s*:\s*([A-Za-z0-9_|\- ]+)/);
  if (!m) return [];
  return m[1].split('|').map(s => s.trim()).filter(Boolean);
}

function isKnownShorthand(s, list) {
  if (!s) return false;
  return list.includes(String(s).toLowerCase());
}

// ---------- Path + lock helpers (sibling .lock file, stale-PID recovery) ----------
function queuePathFor(topicDir) {
  return path.join(topicDir, 'prompt-queue.md');
}
function lockPathFor(topicDir) {
  return queuePathFor(topicDir) + '.lock';
}

function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const owner = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        try { process.kill(owner, 0); } catch { fs.unlinkSync(lockPath); continue; }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return false;
}
function releaseLock(lockPath) { try { fs.unlinkSync(lockPath); } catch {} }

// Strip-prefix regex: matches the `# Prompt Queue` heading followed by the
// HTML comment block, up to and including the closing `-->`. Anchored at
// block start; non-greedy so it does not swallow legitimate `-->` later
// in user content.
const SEED_PREFIX_RE = /^#\s+Prompt Queue[\s\S]*?-->\s*\n?/;

// Fallback: seed block that starts with the heading AND opens an HTML comment
// (`<!--`) but is missing the closing `-->`. The entire block is seed content —
// drop it. We detect: starts-with heading, then has `<!--` anywhere before any
// non-seed user content.
const SEED_OPEN_COMMENT_RE = /^#\s+Prompt Queue\b[\s\S]*?<!--/;

// Detects a block whose only content is the `# Prompt Queue` heading (no body).
const SEED_HEADING_ONLY_RE = /^#\s+Prompt Queue\s*$/;

// Seed header written at the top of the queue file — kept in sync with
// ensureQueueFile so that dequeue operations that leave remaining blocks
// can restore the header without calling ensureQueueFile.
// ---------- Seed header (top-of-file usage/help comment + example) ----------
function buildSeedHeader() {
  return [
    '# Prompt Queue',
    '',
    '<!--',
    'Queued prompts run automatically after the current pipeline finishes',
    '(when `promptQueue.autoAdvance` is true).',
    '',
    'EDIT FREELY: Save this file at any time in any editor. The next drain',
    'after your save picks up the latest content from disk — the harness',
    'never caches parsed queue state across phases.',
    '',
    'FORMAT:',
    '  - Optional header on the first non-blank line of a block:',
    '      `Pipeline: caf`   or just `caf`  (any shorthand from shell-functions.txt)',
    '  - Missing header -> uses `promptQueue.defaultPipeline` (default `all`).',
    '  - Separate blocks with a line containing only `---`.',
    '',
    'HOLD MARKER:',
    '  - Inline:    `Pipeline: caf (hold)` or `pcaf (hold)` on the header line.',
    '  - Body:      `hold` / `(hold)` / `[hold]` / `<HOLD>` as the FIRST non-blank',
    '               line. May sit under a header OR stand alone above a',
    '               header-less prompt body — no `Pipeline:`/shorthand required.',
    '  Held blocks are skipped during dequeue and left in place.',
    '',
    'EXAMPLE (uncomment to use):',
    '',
    '  Pipeline: caf',
    '  Add the foo bar feature to the widget service.',
    '',
    '  ---',
    '',
    '  pcaf',
    '  Then refactor the widget cache to use LRU.',
    '',
    '  ---',
    '',
    '  (hold)',
    '',
    '  Standalone hold above a header-less prompt — skipped during dequeue.',
    '  Remove the `(hold)` line above when ready to dispatch this prompt.',
    '-->',
    '',
    '---',
    '',
  ].join('\n');
}

const _warnedSeedMergeDirs = new Set();

/**
 * Split raw queue text into blocks on lines that are exactly `---`.
 * Returns array of trimmed block strings (empty trailing blocks dropped).
 *
 * Recovery: if a block starts with the seed `# Prompt Queue` header (user
 * forgot the `---` divider after the seed), strip the seed prefix and keep
 * any trailing user content as a real prompt block.
 */
// ---------- Block splitter: divider-aware, strips seed prefix, validates structure ----------
function splitBlocks(text, { log, warnKey } = {}) {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [[]];
  for (const ln of lines) {
    if (DIVIDER_RE.test(ln)) blocks.push([]);
    else blocks[blocks.length - 1].push(ln);
  }
  let recovered = 0;
  const out = [];
  for (const b of blocks) {
    let s = b.join('\n').trim();
    if (!s) continue;
    if (SEED_PREFIX_RE.test(s)) {
      // Stage 1: normal strip (has `-->`)
      const stripped = s.replace(SEED_PREFIX_RE, '').trim();
      if (!stripped) continue;
      s = stripped;
      recovered++;
    } else if (SEED_HEADING_ONLY_RE.test(s)) {
      // Stage 2: bare heading with no recognised user content — drop
      continue;
    } else if (SEED_OPEN_COMMENT_RE.test(s)) {
      // Stage 3: seed block has `<!--` but no `-->` — entire block is seed, drop it.
      // The user content (if any) will be in the next `---`-separated block.
      recovered++;
      continue;
    }
    out.push(s);
  }
  if (recovered > 0) {
    const key = warnKey || '__global__';
    if (!_warnedSeedMergeDirs.has(key)) {
      _warnedSeedMergeDirs.add(key);
      const msg = `prompt-queue: seed block merged with first prompt — recovered ${recovered} body(s); add a '---' divider after the seed`;
      if (typeof log === 'function') log(msg);
      else console.warn(msg);
    }
  }
  return out;
}

/**
 * Parse a single block: extract header (if first non-blank line matches) and
 * the remaining body. Returns { pipeline, headerForm, body, raw }.
 *   pipeline   — resolved shorthand string, or null if no header recognised
 *   headerForm — 'pipeline-key' | 'bare' | null
 *   body       — block content with header line stripped (if present)
 */
// ---------- Block parser: extract header (Pipeline:/bare shorthand) + hold marker + body ----------
function parseBlock(raw, shorthandList) {
  const lines = raw.split('\n');
  let headerIdx = -1, headerVal = null, headerForm = null, headerHold = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const ln = lines[i];
    // Strip trailing `(hold)` so header regexes still match; flag held only
    // when the line is a recognised header.
    const withoutHold = ln.replace(HOLD_INLINE_RE, '');
    const hadInlineHold = withoutHold !== ln;
    let m = withoutHold.match(HEADER_PIPELINE_RE);
    if (m) { headerIdx = i; headerVal = m[1].toLowerCase(); headerForm = 'pipeline-key'; headerHold = hadInlineHold; break; }
    m = withoutHold.match(BARE_SHORTHAND_RE);
    if (m && isKnownShorthand(m[1], shorthandList)) {
      headerIdx = i; headerVal = m[1].toLowerCase(); headerForm = 'bare';
      headerHold = hadInlineHold;
      break;
    }
    break; // first non-blank line was content -> no header
  }
  let body = raw;
  if (headerIdx >= 0) {
    const remaining = lines.slice(headerIdx + 1);
    while (remaining.length && !remaining[0].trim()) remaining.shift();
    body = remaining.join('\n');
  }
  // Hold marker on FIRST non-blank body line — strip so returned `body` is
  // real prompt content. Mid-body `hold` ignored to avoid accidental flips.
  let bodyHold = false;
  if (body) {
    const bodyLines = body.split('\n');
    const firstIdx = bodyLines.findIndex(l => l.trim().length > 0);
    if (firstIdx >= 0 && HOLD_LINE_RE.test(bodyLines[firstIdx])) {
      bodyHold = true;
      bodyLines.splice(0, firstIdx + 1);
      while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
      body = bodyLines.join('\n');
    }
  }
  return { pipeline: headerVal, headerForm, body, raw, held: headerHold || bodyHold };
}

/**
 * Parse the full queue file. Returns { blocks: [...], shorthandList }.
 */
// ---------- Public read-only queue inspection (fresh disk read every call) ----------
function parseQueue(topicDir) {
  const file = queuePathFor(topicDir);
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return { blocks: [], shorthandList: readShorthandList() }; }
  const shorthandList = readShorthandList();
  const rawBlocks = splitBlocks(txt, { warnKey: file });
  const blocks = rawBlocks.map(b => parseBlock(b, shorthandList));
  return { blocks, shorthandList };
}

/**
 * Pop the head block from the queue file (atomic via lock).
 * Returns { block, remainingCount, defaultedPipeline } or null if empty.
 * Pass options:
 *   defaultPipeline — fallback when block has no header (default 'all')
 *   log             — function(msg) for warnings
 * Unknown shorthand in header → warning, head NOT consumed, returns
 *   { block: null, warning: 'unknown-shorthand', ... }.
 */
// ---------- Mutating dequeue: pop head block under lock + rewrite file ----------
function dequeueHead(topicDir, { defaultPipeline = 'all', log = () => {} } = {}) {
  const file = queuePathFor(topicDir);
  if (!fs.existsSync(file)) return null;
  const lock = lockPathFor(topicDir);
  if (!acquireLock(lock)) { log('prompt-queue: failed to acquire lock — skipping dequeue.'); return null; }
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const rawBlocks = splitBlocks(txt, { log, warnKey: file });
    if (rawBlocks.length === 0) return null;
    const shorthandList = readShorthandList();
    const head = parseBlock(rawBlocks[0], shorthandList);
    let pipeline = head.pipeline;
    let defaulted = false;
    if (!pipeline) { pipeline = defaultPipeline; defaulted = true; }
    if (!isKnownShorthand(pipeline, shorthandList)) {
      log(`prompt-queue: unknown shorthand "${pipeline}" in head block — using default "${defaultPipeline}" and leaving queue untouched.`);
      return { block: null, warning: 'unknown-shorthand', remainingCount: rawBlocks.length };
    }
    const remainder = rawBlocks.slice(1);
    if (remainder.length) {
      fs.writeFileSync(file, buildSeedHeader() + '\n' + remainder.join('\n\n---\n\n') + '\n', 'utf8');
    } else {
      // Drained — restore the seed header/instructional comment so the next
      // user opening the file still sees the usage hint instead of an empty buffer.
      try { fs.unlinkSync(file); } catch {}
      ensureQueueFile(topicDir);
    }
    return {
      block: { ...head, pipeline },
      remainingCount: remainder.length,
      defaultedPipeline: defaulted,
    };
  } finally {
    releaseLock(lock);
  }
}

/**
 * Atomically prepend a raw block at the head of the queue file. Used by
 * `dequeueAndTriggerNext` to restore a popped block when in-process
 * continuation fails — the user's prompt must not be lost on failure.
 *
 * `rawBlock` should be the verbatim original block text (header line +
 * body, as returned in `block.raw` by `parseBlock`). Whitespace at the
 * edges is trimmed before splicing so we don't accumulate blank lines.
 * Re-uses the same lock as `dequeueHead` so concurrent mutations are safe.
 */
// ---------- Push-back: requeue a previously-dequeued block at head (failure recovery) ----------
function prependHead(topicDir, rawBlock) {
  if (!rawBlock || !String(rawBlock).trim()) return false;
  ensureQueueFile(topicDir);
  const file = queuePathFor(topicDir);
  const lock = lockPathFor(topicDir);
  if (!acquireLock(lock)) return false;
  try {
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch {}
    const rawBlocks = splitBlocks(txt, { warnKey: file });
    rawBlocks.unshift(String(rawBlock).trim());
    fs.writeFileSync(file, buildSeedHeader() + '\n' + rawBlocks.join('\n\n---\n\n') + '\n', 'utf8');
    return true;
  } finally {
    releaseLock(lock);
  }
}

/**
 * Like `dequeueHead`, but skips blocks marked with the hold tag (either
 * `(hold)` on the header line, or a hold-only line directly under the
 * header). The first unheld block is removed and returned; held blocks
 * remain in the file in their original order.
 *
 * Returns { block, remainingCount, defaultedPipeline, skippedHeld } on success,
 *         { block: null, warning: 'all-held' | 'unknown-shorthand', skippedHeld, remainingCount }
 *         on no-pick, or null if the file is missing/empty.
 */
// ---------- Held-aware dequeue: skip blocks tagged `(hold)`, take next runnable ----------
function dequeueFirstUnheld(topicDir, { defaultPipeline = 'all', log = () => {} } = {}) {
  const file = queuePathFor(topicDir);
  if (!fs.existsSync(file)) return null;
  const lock = lockPathFor(topicDir);
  if (!acquireLock(lock)) { log('prompt-queue: failed to acquire lock — skipping dequeue.'); return null; }
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const rawBlocks = splitBlocks(txt, { log, warnKey: file });
    if (rawBlocks.length === 0) return null;
    const shorthandList = readShorthandList();
    let pickedIdx = -1, picked = null, skippedHeld = 0;
    for (let i = 0; i < rawBlocks.length; i++) {
      const parsed = parseBlock(rawBlocks[i], shorthandList);
      if (parsed.held) { skippedHeld++; continue; }
      pickedIdx = i; picked = parsed; break;
    }
    if (pickedIdx < 0) {
      return { block: null, warning: 'all-held', skippedHeld, remainingCount: rawBlocks.length };
    }
    let pipeline = picked.pipeline;
    let defaulted = false;
    if (!pipeline) { pipeline = defaultPipeline; defaulted = true; }
    if (!isKnownShorthand(pipeline, shorthandList)) {
      log(`prompt-queue: unknown shorthand "${pipeline}" in selected block — leaving queue untouched.`);
      return { block: null, warning: 'unknown-shorthand', skippedHeld, remainingCount: rawBlocks.length };
    }
    const remainder = rawBlocks.slice(0, pickedIdx).concat(rawBlocks.slice(pickedIdx + 1));
    if (remainder.length) {
      fs.writeFileSync(file, buildSeedHeader() + '\n' + remainder.join('\n\n---\n\n') + '\n', 'utf8');
    } else {
      try { fs.unlinkSync(file); } catch {}
      ensureQueueFile(topicDir);
    }
    return {
      block: { ...picked, pipeline },
      remainingCount: remainder.length,
      defaultedPipeline: defaulted,
      skippedHeld,
    };
  } finally {
    releaseLock(lock);
  }
}

// ---------- Counts + file lifecycle (seed-aware creation, full regeneration) ----------
function queueLength(topicDir, { log } = {}) {
  const file = queuePathFor(topicDir);
  if (!fs.existsSync(file)) return 0;
  try { return splitBlocks(fs.readFileSync(file, 'utf8'), { log, warnKey: file }).length; } catch { return 0; }
}

function ensureQueueFile(topicDir) {
  const file = queuePathFor(topicDir);
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, buildSeedHeader(), 'utf8');
  return true;
}

/**
 * Destructive: wipe the queue file (all blocks, including the seed) and
 * re-create a fresh seed via `ensureQueueFile`. Used to recover from a
 * corrupt/desynced queue state. Caller is responsible for confirming user
 * intent — this loses any pending blocks. Atomic via the existing lock.
 *
 * Returns { wiped: boolean, priorCount: number, file: string }.
 *   wiped       — true when a prior queue file existed and was removed
 *   priorCount  — number of blocks (as parsed) that existed pre-wipe
 *   file        — absolute path to the (now freshly-seeded) queue file
 */
function regenerateQueueFile(topicDir) {
  const file = queuePathFor(topicDir);
  const lock = lockPathFor(topicDir);
  if (!acquireLock(lock)) {
    return { wiped: false, priorCount: 0, file, error: 'lock-failed' };
  }
  try {
    let priorCount = 0;
    let wiped = false;
    if (fs.existsSync(file)) {
      try { priorCount = splitBlocks(fs.readFileSync(file, 'utf8'), { warnKey: file }).length; } catch {}
      try { fs.unlinkSync(file); wiped = true; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    ensureQueueFile(topicDir);
    return { wiped, priorCount, file };
  } finally {
    releaseLock(lock);
  }
}

module.exports = {
  HARNESS_DIR,
  SHELL_FUNCTIONS_FILE,
  readShorthandList,
  isKnownShorthand,
  queuePathFor,
  lockPathFor,
  splitBlocks,
  parseBlock,
  parseQueue,
  dequeueHead,
  dequeueFirstUnheld,
  prependHead,
  queueLength,
  ensureQueueFile,
  regenerateQueueFile,
};
