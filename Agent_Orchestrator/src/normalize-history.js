#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// =========================================================================
// History normalization: collapse stacked / orphaned empty "## User Prompt"
// placeholders left behind by historical write paths. Pure transforms +
// idempotent file-rewrite + CLI entry. Exported helpers are reused by
// run-agent.js (injectQueuedPromptIntoHistory) and tests.
// =========================================================================

// Match a trailing `## User Prompt[...]` header (tagged or untagged) whose body
// is whitespace-only to EOF, with optional preceding `---` divider. Used to
// collapse stacked empty placeholders left by historical write paths. We do
// NOT consume a leading `\n+` separator — otherwise the LAST iteration of the
// strip-loop eats the trailing newlines of the PREVIOUS placeholder, and the
// next iteration finds no `\n` after that header to match against. Leaving
// separator-newlines untouched lets the loop collapse arbitrarily-deep stacks
// of placeholders. Caller normalizes trailing whitespace afterwards.
const TRAILING_EMPTY_RE = /(?:---\s*\n+)?## User Prompt[^\n]*\n[ \t\r\n]*$/;

// Recognises a trailing `## User Prompt` placeholder WHETHER OR NOT it carries
// a parenthesised tag (e.g. `(From the Queue)`). Used by appendToFile to avoid
// adding ANOTHER placeholder when one already exists.
const TRAILING_PLACEHOLDER_PRESENT_RE = /##\s+User Prompt(?:\s+\([^)]+\))?\s*\n*\s*$/;

// Collapse every trailing empty `## User Prompt[...]` header down to ZERO.
// Returns { text, collapsed } where collapsed is the count removed. Caller
// decides whether to re-append a single fresh tagged section.
function stripAllTrailingEmptyPlaceholders(text) {
  let next = text;
  let collapsed = 0;
  while (TRAILING_EMPTY_RE.test(next)) {
    next = next.replace(TRAILING_EMPTY_RE, '');
    collapsed++;
  }
  return { text: next, collapsed };
}

// Find an EMPTY `## User Prompt[...]` header (tagged or untagged) immediately
// followed by another `## User Prompt[...]` header, anywhere in the file —
// not only at EOF. The first (empty) one is the orphan to remove. Used to
// retroactively clean live history files that captured the
// stacked-header bug before the unified injection branch landed.
const INTERNAL_EMPTY_PROMPT_RE = /(?:^|\n)(?:---\s*\n+)?##\s+User Prompt[^\n]*\n[ \t\r\n]*(?=(?:---\s*\n+)?##\s+User Prompt[^\n]*\n)/;

function collapseInternalEmptyPromptHeaders(text) {
  let next = text;
  let collapsed = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const m = INTERNAL_EMPTY_PROMPT_RE.exec(next);
    if (!m) break;
    // Preserve the leading separator newline if matched at non-zero offset.
    const lead = m[0].startsWith('\n') ? '\n' : '';
    next = next.slice(0, m.index) + lead + next.slice(m.index + m[0].length);
    collapsed++;
  }
  return { text: next, collapsed };
}

// Read history file at filePath, collapse stacked trailing empty
// `## User Prompt` placeholders AND any internal orphan empty placeholder
// immediately preceding another header, then write back. Idempotent. Returns
// total number of placeholders collapsed (0 if no change).
function normalizeTrailingPromptStack(filePath) {
  let txt;
  try { txt = fs.readFileSync(filePath, 'utf8'); } catch { return 0; }
  const { text: cleaned, collapsed: internal } = collapseInternalEmptyPromptHeaders(txt);
  // Skip if nothing to do: no internal orphans AND at most ONE trailing empty
  // placeholder (the normal post-response shape — must remain idempotent).
  const { text: stripped, collapsed: trailing } = stripAllTrailingEmptyPlaceholders(cleaned);
  if (internal === 0 && trailing <= 1) return 0;
  let next = stripped;
  // Re-append exactly ONE empty trailing placeholder if we stripped any,
  // and only if the resulting tail does not already end with one (could
  // happen when collapseInternalEmptyPromptHeaders left a populated header
  // at EOF).
  if (trailing > 0 && !TRAILING_PLACEHOLDER_PRESENT_RE.test(stripped)) {
    next = stripped.replace(/\s*$/, '') + '\n\n---\n\n## User Prompt\n';
  }
  if (next === txt) return 0;
  fs.writeFileSync(filePath, next, 'utf8');
  return internal + Math.max(0, trailing - 1);
}

// Pure transformation used by injectQueuedPromptIntoHistory: strips all
// trailing empty placeholders then appends exactly one tagged queue section.
// Exported so tests can exercise the real inject logic without module-level state.
function buildQueueInjectedContent(text, body) {
  const { text: stripped } = stripAllTrailingEmptyPlaceholders(text);
  return stripped.replace(/\s*$/, '') + `\n\n---\n\n## User Prompt (From the Queue)\n\n${body}\n`;
}

module.exports = {
  TRAILING_EMPTY_RE,
  TRAILING_PLACEHOLDER_PRESENT_RE,
  stripAllTrailingEmptyPlaceholders,
  collapseInternalEmptyPromptHeaders,
  normalizeTrailingPromptStack,
  buildQueueInjectedContent,
};

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: normalize-history.js <path-to-history.md>'); process.exit(1); }
  const collapsed = normalizeTrailingPromptStack(path.resolve(arg));
  console.log(`[normalize-history] collapsed ${collapsed} duplicate trailing placeholder(s) in ${arg}`);
}
