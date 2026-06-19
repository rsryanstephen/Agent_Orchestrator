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

// Inline key=value model/provider overrides on a header line.
// Highest precedence — override any bare-token resolution on the same line.
// Accepted form: (model=<id>) or (provider=<id>), case-insensitive, any spacing.
const KV_MODEL_RE = /\(\s*model\s*=\s*([A-Za-z0-9._-]+)\s*\)/i;
const KV_PROVIDER_RE = /\(\s*provider\s*=\s*([A-Za-z0-9._-]+)\s*\)/i;

// ---------- Header model/provider tokenizer ----------
// Family keywords map to a provider id (and a default tier). Exact ids
// like `claude-opus-4-7`, `gpt-4.1`, `gemini-2.5-pro` route by prefix.
// Used when the header is a multi-token line such as `(hold) opus caf`
// or `gpt-4.1` — first token from a recognised family/exact-id selects
// `{model, provider}` for that block; the pipeline shorthand may sit
// alongside it in any order.
const FAMILY_TO_PROVIDER = {
  opus:   'claude-code',
  sonnet: 'claude-code',
  haiku:  'claude-code',
  fable:  'claude-code',
  gpt:    'github-copilot',
  gemini: 'gemini',
  pro:    'gemini',
  flash:  'gemini',
};
const FAMILY_TO_TIER = {
  opus: 'heavy', sonnet: 'medium', haiku: 'light', fable: 'medium',
  gpt: 'heavy', gemini: 'heavy', pro: 'heavy', flash: 'light',
};
// Detect a concrete model id (must contain a digit so `opus` family keyword
// is NOT misclassified as an exact id).
const EXACT_MODEL_RE = /^(?:claude-[a-z0-9.\-]+|gpt-[0-9][a-z0-9.\-]*|gemini-[0-9][a-z0-9.\-]*|o\d[a-z0-9.\-]*)$/i;

// Bare provider tokens recognised on the header line — used when the user
// wants to pin the provider but let auto-routing pick the model tier (e.g.
// `github-copilot caf`), or pair the provider with a bare version token
// (`claude-code 4.6`) so the downstream `auto` resolver can pick within it.
const PROVIDER_TOKENS = new Set(['github-copilot', 'claude-code', 'gemini', 'gemini-vertex']);

// Bare version fragment (e.g. `4.6`, `4.5`, `2.5`). Folded into an adjacent
// family/provider token at parseBlock-time to produce a concrete model id
// like `claude-opus-4-6` or `gpt-4.1`.
const VERSION_RE = /^\d+(?:\.\d+)+$/;

function providerForExactModel(id) {
  const l = String(id).toLowerCase();
  if (l.startsWith('claude-')) return 'claude-code';
  if (l.startsWith('gpt-') || /^o\d/.test(l)) return 'github-copilot';
  if (l.startsWith('gemini-')) return 'gemini';
  return null;
}

// Version-segment separator differs per provider: claude ids use `-`
// (`claude-opus-4-6`), gpt/gemini ids use `.` (`gpt-4.1`, `gemini-2.5-pro`).
function versionSeparatorForProvider(provider) {
  return provider === 'claude-code' ? '-' : '.';
}

// Build a concrete model id from a family keyword + bare version token.
// Used when the header carries e.g. `opus 4.6` -> `claude-opus-4-6`.
function buildModelFromFamilyVersion(family, version, provider) {
  const sep = versionSeparatorForProvider(provider);
  const v = version.replace(/\./g, sep);
  if (provider === 'claude-code') return `claude-${family}-${v}`;
  if (provider === 'github-copilot') return `gpt-${v}`;
  if (provider === 'gemini' || provider === 'gemini-vertex') {
    return family === 'gemini' ? `gemini-${v}` : `gemini-${v}-${family}`;
  }
  return family;
}

// Resolve a family keyword (e.g. `opus`, `flash`) to a concrete model id +
// provider. Reads the live model-catalog cache via the model-catalog module
// when available; falls back to the keyword itself (run-agent's
// `resolveModelId` understands the claude families) when the cache is cold.
function resolveFamilyToken(family) {
  const key = String(family).toLowerCase();
  const provider = FAMILY_TO_PROVIDER[key];
  const tier = FAMILY_TO_TIER[key];
  if (!provider || !tier) return null;
  let model = null;
  try {
    const catalog = require('./lib/model-catalog');
    if (typeof catalog.getCachedTier === 'function') {
      model = catalog.getCachedTier(provider, tier);
    }
  } catch {}
  // Cache miss: pass the keyword through. run-agent's `resolveModelId`
  // already maps opus/sonnet/haiku to the LATEST_* constants; for
  // non-claude families we still emit the keyword so the downstream
  // pre-flight catalog refresh can resolve it.
  if (!model) model = key;
  return { model, provider };
}

// Classify a single header token. Returns one of:
//   { kind: 'shorthand', value }                       — known pipeline shorthand
//   { kind: 'model',     model, provider }             — exact id (concrete, e.g. `gpt-4.1`)
//   { kind: 'family',    family, model, provider }    — family keyword (opus/sonnet/gpt/...)
//   { kind: 'provider',  provider }                    — bare provider id (github-copilot/claude-code/gemini/gemini-vertex)
//   { kind: 'version',   version }                     — bare version fragment (4.6, 2.5, ...) — folded later
//   null                                               — token does not belong on the header
function classifyHeaderToken(tok, shorthandList) {
  if (!tok) return null;
  const lower = tok.toLowerCase();
  if (isKnownShorthand(lower, shorthandList)) return { kind: 'shorthand', value: lower };
  if (PROVIDER_TOKENS.has(lower)) return { kind: 'provider', provider: lower };
  if (EXACT_MODEL_RE.test(tok)) {
    const provider = providerForExactModel(tok);
    if (provider) return { kind: 'model', model: tok, provider };
  }
  if (Object.prototype.hasOwnProperty.call(FAMILY_TO_PROVIDER, lower)) {
    const resolved = resolveFamilyToken(lower);
    if (resolved) return { kind: 'family', family: lower, model: resolved.model, provider: resolved.provider };
  }
  if (VERSION_RE.test(tok)) return { kind: 'version', version: tok };
  return null;
}

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
// Header line may carry, in any order: `(hold)`, a `Pipeline:<x>` key OR a
// bare shorthand, AND/OR a model token (family keyword like `opus` or
// exact id like `gpt-4.1`). Recognised as a header only when EVERY token
// on the line matches one of these forms — otherwise treated as body.
function parseBlock(raw, shorthandList, { log } = {}) {
  const lines = raw.split('\n');
  let headerIdx = -1, headerVal = null, headerForm = null, headerHold = false;
  let headerModel = null, headerProvider = null;
  // Captured from (model=X)/(provider=X) KV overrides; applied after the loop.
  let headerKvModel = null, headerKvProvider = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const ln = lines[i];
    // Strip `(hold)` (anywhere on the line) so header parsing ignores it;
    // flag held only when this line is a recognised header.
    let withoutHold = ln;
    const holdMatch = /\(hold\)/i.exec(withoutHold);
    if (holdMatch) withoutHold = (withoutHold.slice(0, holdMatch.index) + withoutHold.slice(holdMatch.index + holdMatch[0].length)).replace(/\s+/g, ' ').trim();
    const hadInlineHold = holdMatch !== null;

    // Strip (model=X) / (provider=X) key-value overrides before token classification.
    // Values are stored in outer-scope vars and applied after the loop at highest precedence.
    const kvModelMatch = KV_MODEL_RE.exec(withoutHold);
    if (kvModelMatch) {
      headerKvModel = kvModelMatch[1];
      withoutHold = (withoutHold.slice(0, kvModelMatch.index) + withoutHold.slice(kvModelMatch.index + kvModelMatch[0].length)).replace(/\s+/g, ' ').trim();
    }
    const kvProviderMatch = KV_PROVIDER_RE.exec(withoutHold);
    if (kvProviderMatch) {
      headerKvProvider = kvProviderMatch[1];
      withoutHold = (withoutHold.slice(0, kvProviderMatch.index) + withoutHold.slice(kvProviderMatch.index + kvProviderMatch[0].length)).replace(/\s+/g, ' ').trim();
    }
    const hadKvOverride = headerKvModel !== null || headerKvProvider !== null;

    // Form A: `Pipeline: X` (may co-exist with a model/provider/version token before/after).
    // Lenient remainder: unknown tokens are ignored (and logged once), not fatal —
    // the explicit `Pipeline:` prefix is signal enough that this is a header.
    const pmatch = withoutHold.match(/Pipeline\s*:\s*([A-Za-z0-9_-]+)/i);
    if (pmatch) {
      const remainder = (withoutHold.slice(0, pmatch.index) + withoutHold.slice(pmatch.index + pmatch[0].length)).trim();
      let modelTok = null, provider = null, family = null, providerTok = null, versionTok = null;
      const unrecognised = [];
      if (remainder) {
        for (const tok of remainder.split(/\s+/)) {
          const c = classifyHeaderToken(tok, shorthandList);
          if (!c) { unrecognised.push(tok); continue; }
          if (c.kind === 'model') { modelTok = c.model; provider = c.provider; family = null; }
          else if (c.kind === 'family') { family = c.family; modelTok = c.model; provider = c.provider; }
          else if (c.kind === 'provider') { providerTok = c.provider; }
          else if (c.kind === 'version') { versionTok = c.version; }
        }
      }
      if (family && versionTok) modelTok = buildModelFromFamilyVersion(family, versionTok, provider || providerTok || FAMILY_TO_PROVIDER[family]);
      if (!provider && providerTok) provider = providerTok;
      if (unrecognised.length && typeof log === 'function') {
        log(`prompt-queue: unrecognised header token(s) ignored: ${unrecognised.join(', ')}`);
      }
      headerIdx = i; headerVal = pmatch[1].toLowerCase(); headerForm = 'pipeline-key';
      headerHold = hadInlineHold; headerModel = modelTok; headerProvider = provider;
      break;
    }

    // Form B: multi-token bare line — each token is shorthand/model/family/provider/version.
    // Lenient: unknown tokens go to `unrecognised[]` instead of aborting the
    // header parse. Accept the line as a header when EITHER (a) we recognised
    // every token (strict — preserves single-token headers like `fable`), OR
    // (b) at least two tokens classified (multi-signal — prose lines like
    // "Fable is a great model" classify only one token and stay as body).
    const tokens = withoutHold.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      let pipelineTok = null, modelTok = null, provider = null, family = null, providerTok = null, versionTok = null;
      const unrecognised = [];
      let classifiedCount = 0;
      for (const tok of tokens) {
        const c = classifyHeaderToken(tok, shorthandList);
        if (!c) { unrecognised.push(tok); continue; }
        if (c.kind === 'shorthand') {
          // Conflicting pipeline shorthands on the same line — demote the
          // second to "unrecognised" rather than poisoning the whole header.
          if (pipelineTok && pipelineTok !== c.value) { unrecognised.push(tok); continue; }
          pipelineTok = c.value;
        } else if (c.kind === 'model') {
          modelTok = c.model; provider = c.provider; family = null;
        } else if (c.kind === 'family') {
          family = c.family; modelTok = c.model; provider = c.provider;
        } else if (c.kind === 'provider') {
          providerTok = c.provider;
        } else if (c.kind === 'version') {
          versionTok = c.version;
        }
        classifiedCount++;
      }
      // Fold a bare version fragment into the family keyword (e.g.
      // `opus 4.6` -> `claude-opus-4-6`) using the provider-aware separator.
      if (family && versionTok) modelTok = buildModelFromFamilyVersion(family, versionTok, provider || providerTok || FAMILY_TO_PROVIDER[family]);
      // Provider-only token wins when no family/exact model accompanied it —
      // routes the block to that provider's `auto`-tier resolver.
      if (!provider && providerTok) provider = providerTok;
      const hasSignal = pipelineTok || modelTok || provider || hadKvOverride;
      // Accept when classified tokens are at least as many as unknowns —
      // permits a single-token typo like `opus typo` (1 vs 1) while prose
      // "Fable is a great model" (2 classified vs 3 unknown) stays as body.
      // KV-only lines (hadKvOverride with no other classifiable tokens) also accepted.
      const headerLike = hasSignal && (classifiedCount >= 1 || hadKvOverride) && classifiedCount >= unrecognised.length;
      if (headerLike) {
        if (unrecognised.length && typeof log === 'function') {
          log(`prompt-queue: unrecognised header token(s) ignored: ${unrecognised.join(', ')}`);
        }
        headerIdx = i; headerVal = pipelineTok;
        headerForm = pipelineTok ? 'bare' : (modelTok ? 'model-only' : 'provider-only');
        headerHold = hadInlineHold; headerModel = modelTok; headerProvider = provider;
        break;
      }
    }
    // A KV-only line (only (model=X)/(provider=X), no other classifiable tokens)
    // is still a valid header — do not silently drop the override into body.
    if (hadKvOverride) {
      headerIdx = i; headerVal = null; headerForm = 'kv-only'; headerHold = hadInlineHold; break;
    }
    break; // first non-blank line was content -> no header
  }
  // Apply (model=X)/(provider=X) key-value overrides at highest precedence.
  // Infer provider from the model id when (provider=X) is absent.
  if (headerIdx >= 0) {
    if (headerKvModel !== null) {
      headerModel = headerKvModel;
      if (headerKvProvider === null) {
        const inferred = providerForExactModel(headerKvModel);
        if (inferred) headerProvider = inferred;
      }
    }
    if (headerKvProvider !== null) headerProvider = headerKvProvider;
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
  // Expose parsed model/provider so callers can route the dequeued block to
  // the requested LLM. `null` when the header carried no model token.
  return {
    pipeline: headerVal,
    headerForm,
    body,
    raw,
    held: headerHold || bodyHold,
    model: headerModel,
    provider: headerProvider,
  };
}

/**
 * Parse a `## User Prompt` block's body for an optional per-prompt header.
 * Thin wrapper over `parseBlock` so the prompt-file header grammar is IDENTICAL
 * to the queue header grammar (shorthand / model family / exact id / (model=X)).
 * Returns { pipeline, model, provider, body } — pipeline/model/provider are
 * null when the first non-blank line is prose (no header recognised), and
 * `body` is the block text with the header line stripped (or unchanged).
 */
// ---------- Per-prompt header parse: reuse queue grammar on a User Prompt block ----------
// `shorthandList` is optional; defaults to the live shell-functions list so
// callers (run-agent dispatch) need not thread it through.
function parsePromptFileHeader(blockText, shorthandList, { log } = {}) {
  const list = shorthandList || readShorthandList();
  const parsed = parseBlock(String(blockText || ''), list, { log });
  return { pipeline: parsed.pipeline, model: parsed.model, provider: parsed.provider, body: parsed.body };
}

/**
 * Parse the full queue file. Returns { blocks: [...], shorthandList }.
 */
// ---------- Public read-only queue inspection (fresh disk read every call) ----------
// Accept optional `log` so bulk callers (queue regeneration, inspection)
// also surface unrecognised-token warnings — previously silent.
function parseQueue(topicDir, { log } = {}) {
  const file = queuePathFor(topicDir);
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return { blocks: [], shorthandList: readShorthandList() }; }
  const shorthandList = readShorthandList();
  const rawBlocks = splitBlocks(txt, { warnKey: file, log });
  const blocks = rawBlocks.map(b => parseBlock(b, shorthandList, { log }));
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
    const head = parseBlock(rawBlocks[0], shorthandList, { log });
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
// ---------- Body-integrity guard: detect a half-saved/truncated prompt body ----------
// Defense-in-depth backstop for the editor-buffer race: when a queue block was
// re-read mid-save, its body can be cut off. Pure predicate (no I/O) — returns
// true on the conservative truncation signals only, to avoid false-holding a
// legitimately-short prompt: (1) odd count of ``` fences (unterminated code
// block), (2) odd inline-backtick count after fences removed (unterminated
// inline span), (3) trimmed body ends with a trailing `:` (cut mid-list).
function looksTruncated(body) {
  if (!body) return false;
  const trimmed = String(body).trim();
  if (!trimmed) return false;
  const fenceCount = (trimmed.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) return true;
  const withoutFences = trimmed.replace(/```/g, '');
  const inlineTicks = (withoutFences.match(/`/g) || []).length;
  if (inlineTicks % 2 !== 0) return true;
  if (/:\s*$/.test(trimmed)) return true;
  return false;
}

// ---------- Truncation-hold release valve (deadlock guard) ----------
// `looksTruncated` is conservative but can FALSE-POSITIVE on a fully-saved
// prompt that legitimately ends in `:` or carries an unbalanced backtick in
// prose. Such a head block would otherwise be held FOREVER, wedging every
// block behind it. Fix: persist a per-head consecutive-hold counter in a
// sidecar file. The editor-flush race resolves within one drain (the save
// lands and the body stops looking truncated); so a body that STILL looks
// truncated after N consecutive identical holds is genuinely complete —
// release it. The counter resets whenever the head body changes.
const MAX_TRUNCATION_HOLDS = 3;

function truncHoldPathFor(topicDir) {
  return queuePathFor(topicDir) + '.trunc-hold';
}

// Cheap, stable 32-bit fingerprint of the held body — distinguishes "same
// truncated head re-seen" (increment) from "head changed" (reset).
function fingerprint(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `${str.length}:${h >>> 0}`;
}

// Returns the post-increment consecutive-hold count for `body`. Resets to 1
// when the fingerprint differs from the last recorded hold.
function bumpTruncationHold(topicDir, body) {
  const file = truncHoldPathFor(topicDir);
  const fp = fingerprint(body);
  let count = 0, prevFp = null;
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    prevFp = prev.fp; count = prev.count | 0;
  } catch {}
  count = (prevFp === fp) ? count + 1 : 1;
  try { fs.writeFileSync(file, JSON.stringify({ fp, count }), 'utf8'); } catch {}
  return count;
}

// Clear the hold counter — called once a block is actually dequeued so a
// later truncated head starts its hold count fresh.
function clearTruncationHold(topicDir) {
  try { fs.unlinkSync(truncHoldPathFor(topicDir)); } catch {}
}

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
      const parsed = parseBlock(rawBlocks[i], shorthandList, { log });
      if (parsed.held) { skippedHeld++; continue; }
      pickedIdx = i; picked = parsed; break;
    }
    if (pickedIdx < 0) {
      return { block: null, warning: 'all-held', skippedHeld, remainingCount: rawBlocks.length };
    }
    // Body-integrity backstop: a head block whose body looks half-saved (the
    // editor-flush race) must NOT be popped — hold it queued so the next drain
    // (after the save lands) processes the whole prompt instead of a fragment.
    // Release valve: a benign trailing `:` / prose backtick survives every
    // drain unchanged, so after MAX_TRUNCATION_HOLDS identical consecutive
    // holds we release it — otherwise it wedges the queue head forever.
    if (looksTruncated(picked.body)) {
      const holds = bumpTruncationHold(topicDir, picked.body);
      if (holds < MAX_TRUNCATION_HOLDS) {
        log(`prompt-queue: head block body looks truncated (unterminated code span / trailing colon) — holding in queue until save settles (hold ${holds}/${MAX_TRUNCATION_HOLDS}).`);
        return { block: null, warning: 'truncated-held', skippedHeld, remainingCount: rawBlocks.length, truncationHolds: holds };
      }
      log(`prompt-queue: head block still looks truncated after ${holds} consecutive holds — body unchanged across drains, treating as complete and releasing.`);
    }
    let pipeline = picked.pipeline;
    let defaulted = false;
    if (!pipeline) { pipeline = defaultPipeline; defaulted = true; }
    if (!isKnownShorthand(pipeline, shorthandList)) {
      log(`prompt-queue: unknown shorthand "${pipeline}" in selected block — leaving queue untouched.`);
      return { block: null, warning: 'unknown-shorthand', skippedHeld, remainingCount: rawBlocks.length };
    }
    // A block is being popped — reset the truncation-hold counter so a future
    // truncated head starts fresh rather than inheriting this head's count.
    clearTruncationHold(topicDir);
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
  parsePromptFileHeader,
  parseQueue,
  looksTruncated,
  MAX_TRUNCATION_HOLDS,
  truncHoldPathFor,
  clearTruncationHold,
  dequeueHead,
  dequeueFirstUnheld,
  prependHead,
  queueLength,
  ensureQueueFile,
  regenerateQueueFile,
};
