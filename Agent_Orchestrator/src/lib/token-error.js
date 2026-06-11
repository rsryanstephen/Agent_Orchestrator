'use strict';

// ── Error-text signature regexes ──────────────────────────────────────────
// Phrase patterns Claude CLI emits when it has run out of tokens. Used by
// classifyTokenError below to distinguish monthly cap vs. rolling rate limit.
const MONTHLY_CAP_REGEX = /monthly spend limit|monthly usage limit|hit your org['']s monthly/i;
const RATE_RESET_REGEX = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;

/**
 * Classify a token-related error from Claude CLI.
 * Accepts either a raw stderr/stdout string or an Error object with .message
 * and optionally pre-parsed .tokenReset.
 *
 * Returns { kind: 'monthly' }
 *       | { kind: 'rate', reset: {hour, minute, ampm, tz} | null }
 *       | { kind: null }
 */
function classifyTokenError(stderrOrErrObj) {
  const buf = typeof stderrOrErrObj === 'string'
    ? stderrOrErrObj
    : (stderrOrErrObj && (stderrOrErrObj.stderrBuf || stderrOrErrObj.message || ''));

  // Rate-limit detection takes precedence over the monthly-cap phrase: when Claude
  // surfaces a parseable reset time, treat as the (5-hour) session limit even if the
  // message text says "monthly spend limit" — the misleading copy was observed in
  // practice for a 5-hour limit. Only fall through to monthly when NO reset time
  // can be parsed (genuine monthly cap has no machine-readable refresh time).
  const m = (buf || '').match(RATE_RESET_REGEX);
  if (m) {
    return {
      kind: 'rate',
      reset: {
        hour: parseInt(m[1], 10),
        minute: m[2] ? parseInt(m[2], 10) : 0,
        ampm: m[3] ? m[3].toLowerCase() : null,
        tz: m[4] ? m[4].trim() : null,
      },
    };
  }

  if (MONTHLY_CAP_REGEX.test(buf)) {
    return { kind: 'monthly' };
  }

  return { kind: null };
}

// Provider-specific transient signals. Generic "api error" removed -> false-positives on
// benign log lines mentioning "API error". Require explicit HTTP status, Anthropic error
// type, or canonical phrase. Anthropic api_error w/ 5xx -> matched via 5\d\d clause.
const TRANSIENT_REGEX = /\b(429|5\d\d)\b|overloaded_error|\boverloaded\b|rate[_ -]?limit(?:ed)?|too many requests|service unavailable|temporarily unavailable|upstream_error/i;

function classifyTransientError(stderrOrErrObj) {
  const buf = typeof stderrOrErrObj === 'string'
    ? stderrOrErrObj
    : (stderrOrErrObj && (stderrOrErrObj.stderrBuf || stderrOrErrObj.message || ''));
  if (!buf) return { kind: null };
  if (MONTHLY_CAP_REGEX.test(buf)) return { kind: null };
  if (RATE_RESET_REGEX.test(buf)) return { kind: null };
  if (TRANSIENT_REGEX.test(buf)) return { kind: 'transient' };
  return { kind: null };
}

// Canary phrase Claude CLI prints when `--model <id>` is unknown to the account/provider.
// Matches EITHER half (top-level `|`): the "selected model ... may not exist or you may
// not have access" line OR the "Run --model to pick a different model" hint. Either alone
// is a real CLI failure signature; precedence over noisy 429/5xx substrings is enforced
// by the caller (claude-code.js `on('close')` checks model-availability FIRST), not by
// this regex. Capture group 1 extracts the offending model id from the parenthesised
// "selected model (<id>) ..." form so callers can surface it to the user.
const MODEL_UNAVAILABLE_REGEX = /selected model(?:\s*\(([^)]+)\))?[\s\S]{0,200}?may not exist or you may not have access|Run\s+--model\s+to\s+pick\s+a\s+different\s+model/i;

function classifyModelAvailabilityError(stderrOrErrObj) {
  const buf = typeof stderrOrErrObj === 'string'
    ? stderrOrErrObj
    : (stderrOrErrObj && (stderrOrErrObj.stderrBuf || stderrOrErrObj.message || ''));
  if (!buf) return { kind: null };
  const m = buf.match(MODEL_UNAVAILABLE_REGEX);
  if (!m) return { kind: null };
  return { kind: 'model-unavailable', model: m[1] ? m[1].trim() : null };
}

module.exports = { classifyTokenError, classifyTransientError, classifyModelAvailabilityError, MONTHLY_CAP_REGEX, RATE_RESET_REGEX, TRANSIENT_REGEX, MODEL_UNAVAILABLE_REGEX };
