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
// `stream idle timeout` / `partial response received` added: the Claude CLI emits these
// when a streamed response stalls mid-flight; it is transient (retry succeeds) so it must
// retry-with-backoff instead of killing the pipeline via die().
const TRANSIENT_REGEX = /\b(429|5\d\d)\b|overloaded_error|\boverloaded\b|rate[_ -]?limit(?:ed)?|too many requests|service unavailable|temporarily unavailable|upstream_error|stream idle timeout|partial response received/i;

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
// Matches THREE shapes (top-level `|`): (1) Claude's "selected model ... may not exist or
// you may not have access" line, (2) Claude's "Run --model to pick a different model" hint,
// (3) Copilot CLI's `Model "<id>" from --model flag is not available.` line. Any one alone
// is a real CLI failure signature; precedence over noisy 429/5xx substrings is enforced by
// the caller (claude-code.js `on('close')` checks model-availability FIRST), not by this
// regex. Capture group 1 extracts the offending model id from Claude's parenthesised
// "selected model (<id>) ..." form; capture group 2 extracts it from Copilot's
// quoted `Model "<id>" from --model flag` form — so callers can surface it to the user.
const MODEL_UNAVAILABLE_REGEX = /selected model(?:\s*\(([^)]+)\))?[\s\S]{0,200}?may not exist or you may not have access|Run\s+--model\s+to\s+pick\s+a\s+different\s+model|Model\s+"?([^"\n]+?)"?\s+from\s+--model\s+flag\s+is\s+not\s+available/i;

// Classifies model-unavailability errors across providers. Extended to detect the Copilot
// CLI string in addition to Claude's so that `err.modelUnavailable` is set and the
// omit-`--model` retry fallback in run-agent.js can fire; without this branch the Copilot
// failure was classified as `{kind:null}` and the phase died as error_unknown.
function classifyModelAvailabilityError(stderrOrErrObj) {
  const buf = typeof stderrOrErrObj === 'string'
    ? stderrOrErrObj
    : (stderrOrErrObj && (stderrOrErrObj.stderrBuf || stderrOrErrObj.message || ''));
  if (!buf) return { kind: null };
  const m = buf.match(MODEL_UNAVAILABLE_REGEX);
  if (!m) return { kind: null };
  // group 1 = Claude parenthesised id; group 2 = Copilot quoted id.
  const model = (m[1] || m[2] || '').trim() || null;
  return { kind: 'model-unavailable', model };
}

// ── Context-window / prompt-too-long detection ─────────────────────────────
// Matches Claude Code CLI strings emitted when the prompt exceeds the model's
// context window. Distinct from rate/monthly token caps: the FIX is to swap
// model or clear memory, not wait for a reset clock. Pattern list kept here as
// one constant so future CLI string changes only require one edit point.
// Why: previously this surfaced to the user as cryptic `Claude exited with code 1`
//      which masked the actionable signal (switch model / clear memory).
// Anchored to context-window overflow shapes only. The earlier broad
// `invalid_request_error[\s\S]{0,200}?tokens` half false-positived on auth/billing
// errors that happened to mention "tokens" (e.g. "invalid api token"); the tighter
// pattern requires explicit context/prompt-length wording near the tokens noun so
// rate/billing failures are NOT mis-routed into the "switch model / clear memory"
// branch. Each alternative is a distinct Anthropic/Claude CLI overflow signature.
const CONTEXT_LIMIT_REGEX = /Prompt is too long|context length|maximum context|context window|input is too long|tokens?\s+exceeds?\s+(?:the\s+)?(?:model['']?s\s+)?(?:maximum|limit|context)|invalid_request_error[\s\S]{0,200}?(?:prompt|context|input)[\s\S]{0,40}?tokens|tokens[\s\S]{0,40}?(?:exceed|exceeds|exceeded|too\s+long|too\s+many)[\s\S]{0,80}?(?:context|window|limit|maximum)/i;

// Returns { kind: 'context-limit' } when the buffer carries a context-window
// overflow signature. Caller surfaces a dedicated user-facing message.
function classifyContextLimitError(stderrOrErrObj) {
  const buf = typeof stderrOrErrObj === 'string'
    ? stderrOrErrObj
    : (stderrOrErrObj && (stderrOrErrObj.stderrBuf || stderrOrErrObj.message || ''));
  if (!buf) return { kind: null };
  if (CONTEXT_LIMIT_REGEX.test(buf)) return { kind: 'context-limit' };
  return { kind: null };
}

// Typed error thrown / tagged on Provider failures when the CLI reports a
// context-window overflow. Carries `model` + `phase` so the caller can render
// an actionable message (switch model / clear memory) instead of "exited 1".
class TokenLimitError extends Error {
  constructor(message, { model = null, phase = null } = {}) {
    super(message);
    this.name = 'TokenLimitError';
    this.contextLimitHit = true;
    this.model = model;
    this.phase = phase;
  }
}

// Provider-specific token/quota-exhaustion signatures used to trigger the
// cross-provider fallback chain in run-agent.js. Distinct from Claude's rate
// regex above because Copilot/Gemini emit no machine-parseable reset clock —
// detection alone is enough to swap to the next provider in `fallback-providers`.
const PROVIDER_TOKEN_EXHAUSTED_REGEX = /\bquota\s+(?:exceeded|exhausted)\b|resource[_ ]exhausted|premium\s+request|monthly\s+request\s+limit|tokens?\s+(?:have\s+)?run\s+out|usage\s+limit\s+exceeded|insufficient\s+quota/i;

// Returns { kind: 'tokens-exhausted' } if the error text matches a provider-quota
// signature OR carries an explicit `tokensExhausted` flag set by registry.js.
// Used by run-agent.js to decide whether to consult `fallback-providers`.
function classifyTokensExhausted(stderrOrErrObj) {
  if (stderrOrErrObj && typeof stderrOrErrObj === 'object' && stderrOrErrObj.tokensExhausted) {
    return { kind: 'tokens-exhausted' };
  }
  const buf = typeof stderrOrErrObj === 'string'
    ? stderrOrErrObj
    : (stderrOrErrObj && (stderrOrErrObj.stderrBuf || stderrOrErrObj.message || ''));
  if (!buf) return { kind: null };
  if (PROVIDER_TOKEN_EXHAUSTED_REGEX.test(buf)) return { kind: 'tokens-exhausted' };
  return { kind: null };
}

module.exports = { classifyTokenError, classifyTransientError, classifyModelAvailabilityError, classifyTokensExhausted, classifyContextLimitError, TokenLimitError, MONTHLY_CAP_REGEX, RATE_RESET_REGEX, TRANSIENT_REGEX, MODEL_UNAVAILABLE_REGEX, PROVIDER_TOKEN_EXHAUSTED_REGEX, CONTEXT_LIMIT_REGEX };
