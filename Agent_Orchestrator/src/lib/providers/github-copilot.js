'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { classifyTransientError } = require('../token-error');

// Copilot/OpenAI-style finish reasons that indicate non-natural stop.
const COPILOT_TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'content_filter', 'safety']);

// ── Schema verified against @github/copilot v1.0+ (GA, Feb 2026) ──────────────
// GA CLI emits dotted-type JSONL events with a nested `data` object:
//   { type: 'assistant.message', data: { content: '...' } }
//   { type: 'assistant.usage',   data: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }
//   { type: 'session.error',     data: { errorType: 'quota'|'rate_limit'|'authentication', message, statusCode } }
// Legacy flat aliases (type:'message', entry.text) kept for pre-GA CLI builds.
// Rate-limit HTTP headers are NOT exposed in GA JSONL; statusCode is in data.statusCode.

function parseCopilotLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const t = entry.type;
  if (!t) return null;
  const d = entry.data || {};

  // GA: assistant.message { data.content } — legacy: message/text/assistant with entry.text
  if (t === 'assistant.message' || t === 'message' || t === 'text' || t === 'assistant' || t === 'assistant_message') {
    const text = d.content || d.text || entry.text || entry.content || entry.message || '';
    if (!text) return null;
    const finishReason = d.finishReason || d.finish_reason || d.stopReason || d.stop_reason || entry.finish_reason || null;
    return { kind: 'assistant_text', text: String(text), model: d.model || entry.model || null, finishReason };
  }

  // GA: tool.request { data.toolCallId, data.name, data.arguments } — legacy: tool_call
  if (t === 'tool_call' || t === 'tool_use' || t === 'function_call' || t === 'tool.request') {
    return {
      kind: 'tool_call',
      id: d.toolCallId || d.id || entry.id || entry.tool_id || entry.call_id || '',
      name: d.name || d.toolName || entry.name || entry.tool_name || entry.function_name || '',
      input: d.arguments || d.input || d.parameters || entry.input || entry.arguments || entry.parameters || {},
    };
  }

  // GA: tool.response { data.toolCallId, data.output } — legacy: tool_result
  if (t === 'tool_result' || t === 'tool_response' || t === 'function_result' || t === 'tool.response') {
    const raw = d.output || d.content || d.result || entry.output || entry.content || entry.result || '';
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const output = str.length > 65536 ? str.slice(0, 65536) + '[TRUNCATED]' : str;
    return {
      kind: 'tool_result',
      call_id: d.toolCallId || d.callId || d.call_id || entry.call_id || entry.tool_use_id || entry.id || '',
      output,
      is_error: !!(d.is_error || d.error || entry.is_error || entry.error),
    };
  }

  // GA: assistant.usage { data.inputTokens, data.outputTokens, data.cacheReadTokens, data.cacheWriteTokens }
  // legacy: usage/token_usage/tokens with flat entry.input_tokens
  if (t === 'assistant.usage' || t === 'usage' || t === 'token_usage' || t === 'tokens') {
    return {
      kind: 'usage',
      input_tokens: d.inputTokens ?? entry.input_tokens ?? entry.prompt_tokens ?? null,
      output_tokens: d.outputTokens ?? entry.output_tokens ?? entry.completion_tokens ?? null,
      cache_read_tokens: d.cacheReadTokens ?? entry.cache_read_tokens ?? null,
      cache_write_tokens: d.cacheWriteTokens ?? entry.cache_write_tokens ?? null,
      ratelimit: extractRateLimitFields(entry),
    };
  }

  // GA: session.error { data.errorType: 'quota'|'rate_limit'|'authentication', data.message }
  if (t === 'session.error') {
    const errorType = d.errorType || '';
    const message = d.message || entry.message || 'Unknown error';
    if (errorType === 'quota' || errorType === 'rate_limit' || /quota|rate.?limit|premium.?request/i.test(message)) {
      return { kind: 'error_quota', message, ratelimit: extractRateLimitFields(entry) };
    }
    const isAuth = errorType === 'authentication' || /401|unauthorized|auth/i.test(message);
    return { kind: 'error', code: isAuth ? 'error_auth' : (d.code || 'error_unknown'), message };
  }

  // Legacy quota/rate-limit type strings
  if (
    t === 'quota_exceeded' || t === 'rate_limit_exceeded' ||
    t === 'error_quota' ||
    (t === 'error' && /quota|rate.?limit|premium.?request/i.test(entry.message || ''))
  ) {
    return {
      kind: 'error_quota',
      message: entry.message || 'Premium request quota exhausted',
      ratelimit: extractRateLimitFields(entry),
    };
  }

  if (t === 'error') {
    const isAuth = /401|unauthorized|auth/i.test(entry.message || '');
    return {
      kind: 'error',
      code: isAuth ? 'error_auth' : (entry.code || 'error_unknown'),
      message: entry.message || 'Unknown error',
    };
  }

  // session.shutdown and other GA lifecycle events — not meaningful for output parsing
  return null;
}

// Pull x-ratelimit-* values from a log entry.
// GA CLI (v1.0+) does NOT include HTTP headers in JSONL — rate-limit info is in
// session.error data.statusCode only. Kept for legacy/custom CLI builds.
function extractRateLimitFields(entry) {
  const headers = entry.headers || entry.ratelimit_headers || entry['x-ratelimit'] || null;
  if (!headers || typeof headers !== 'object') return null;
  const result = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/x-ratelimit/i.test(k)) result[k.toLowerCase()] = v;
  }
  return Object.keys(result).length ? result : null;
}

// ── Capabilities ──────────────────────────────────────────────────────────────

const capabilities = {
  mcp: true,
  tools: true,
  planMode: false,
  skillsRuntime: false,
  subAgents: false,
  autoResume: false,
  streamJson: false,
  hooks: false,
  permissionMode: false,
};

function supportsFeature(name) {
  return !!(capabilities[name]);
}

// ── Auth probe ────────────────────────────────────────────────────────────────

function probe() {
  const bin = 'copilot';
  let r = spawnSync(bin, ['--version'], {
    shell: false,
    timeout: 8000,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL') && process.platform === 'win32') {
    r = spawnSync('copilot.cmd', ['--version'], {
      shell: true,
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  return r.status === 0 && !r.error;
}

function loginInstructions() {
  return "Install GitHub Copilot CLI (standalone, public preview). Run 'copilot auth login' to authenticate (saves to ~/.copilot/). Verify with 'copilot --version'. Requires active Copilot subscription (Pro: 300 premium req/mo; Business: 1500/mo). DO NOT use 'gh copilot' — that is the legacy extension.";
}

// ── Hook registry (Gap #6: JS callbacks instead of settings.json hook dispatch) ─

const _preHooks = [];
const _postHooks = [];

/**
 * Register a pre- or post-spawn callback.
 * phase: 'pre' fires synchronously before the copilot process is spawned.
 * phase: 'post' fires synchronously after the child emits 'close' or 'error'.
 * Use this instead of settings.json hook dispatch for Copilot runs — the
 * provider has capabilities.hooks=false so the harness hook runner never fires.
 * Callers (run-agent.js) register editor-buffer-flush and sound callbacks here.
 */
function registerHook(phase, fn) {
  if (phase === 'pre') _preHooks.push(fn);
  else if (phase === 'post') _postHooks.push(fn);
}

/** Remove all registered hooks (test helper). */
function clearHooks() {
  _preHooks.length = 0;
  _postHooks.length = 0;
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

function resolvecopilotBin() {
  if (process.platform !== 'win32') return { bin: 'copilot', shell: false };
  const r = spawnSync('copilot', ['--version'], { shell: false, timeout: 3000, encoding: 'utf8', windowsHide: true });
  if (!r.error) return { bin: 'copilot', shell: false };
  return { bin: 'copilot.cmd', shell: true };
}

/**
 * Spawn the copilot CLI for one agent run.
 * opts: { prompt, model?, mcpConfig?, cwd?, _spawn? }
 *   _spawn: override the internal spawn() call (test-only injection).
 * Returns { child, logDir, waitForExit } where waitForExit() -> Promise<exitCode>.
 * Pre-hooks fire before spawn; post-hooks fire after child exits.
 * A heartbeat line "still working... (Ns)" is written to stdout every 5 s.
 */
function spawnCopilot(opts) {
  const { prompt, model, mcpConfig, cwd, silent, _spawn: spawnFn = spawn } = opts || {};
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-harness-'));

  for (const fn of _preHooks) { try { fn(); } catch {} }

  const args = ['-p', String(prompt), '--allow-all-tools', '--log-dir', logDir];
  if (model && model.trim()) args.push('--model', model.trim());
  if (mcpConfig && fs.existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig);

  const { bin, shell } = resolvecopilotBin();
  const child = spawnFn(bin, args, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
    windowsHide: true,
  });

  const startMs = Date.now();
  const heartbeatTimer = silent ? null : setInterval(() => {
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    process.stdout.write(`still working... (${elapsed}s)\n`);
  }, 5000);

  const _runPostHooks = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const fn of _postHooks) { try { fn(); } catch {} }
  };

  const waitForExit = () => new Promise((resolve) => {
    child.on('close', (code) => { _runPostHooks(); resolve(code ?? 1); });
    child.on('error', () => { _runPostHooks(); resolve(1); });
  });

  return { child, logDir, waitForExit };
}

// ── JSONL reader ──────────────────────────────────────────────────────────────

function readLogDirJsonl(logDir) {
  if (!fs.existsSync(logDir)) return [];
  const lines = [];
  try {
    for (const fname of fs.readdirSync(logDir).sort()) {
      if (!fname.endsWith('.jsonl') && !fname.endsWith('.json')) continue;
      const raw = fs.readFileSync(path.join(logDir, fname), 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { lines.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
      }
    }
  } catch { /* best-effort */ }
  return lines;
}

// ── parseStream ───────────────────────────────────────────────────────────────

/**
 * Synthesize normalized events (§12) from post-exit copilot log-dir JSONL.
 * exitCode: process exit code from waitForExit().
 * logDir:   path written via --log-dir.
 * stderrBuf: accumulated stderr text (for error detection).
 * Returns array of normalized event objects.
 */
function parseStream(exitCode, logDir, stderrBuf, opts) {
  const now = Date.now();
  const events = [];
  const enableStopReasonFallback = !!(opts && opts.enableStopReasonFallback);
  let finishReason = null;

  // Handle spawn/auth failures before reading log dir.
  if (exitCode !== 0 && (!logDir || !fs.existsSync(logDir))) {
    const isAuth = /401|unauthorized|auth/i.test(stderrBuf || '');
    events.push({
      type: 'error',
      ts: now,
      content: {
        code: isAuth ? 'error_auth' : 'error_spawn',
        message: (stderrBuf || '').trim() || 'copilot process failed to start',
        recoverable: false,
      },
    });
    events.push({ type: 'done', ts: now, content: { exit_code: exitCode, session_id: null } });
    return events;
  }

  const rawEntries = readLogDirJsonl(logDir || '');
  let usageAccum = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, ratelimit: null };
  let quotaError = null;

  for (const entry of rawEntries) {
    const parsed = parseCopilotLogEntry(entry);
    if (!parsed) continue;

    const ts = typeof entry.ts === 'number' ? entry.ts : (typeof entry.timestamp === 'number' ? entry.timestamp : now);

    switch (parsed.kind) {
      case 'assistant_text':
        if (parsed.finishReason) finishReason = parsed.finishReason;
        events.push({
          type: 'assistant_text',
          ts,
          role: 'assistant',
          content: { text: parsed.text },
          meta: parsed.model ? { model: parsed.model } : undefined,
        });
        break;

      case 'tool_call':
        events.push({
          type: 'tool_call',
          ts,
          role: 'assistant',
          content: { id: parsed.id, name: parsed.name, input: parsed.input },
        });
        break;

      case 'tool_result':
        events.push({
          type: 'tool_result',
          ts,
          role: 'tool',
          content: { call_id: parsed.call_id, output: parsed.output, is_error: parsed.is_error },
        });
        break;

      case 'usage':
        if (parsed.input_tokens != null) usageAccum.input_tokens = (usageAccum.input_tokens || 0) + parsed.input_tokens;
        if (parsed.output_tokens != null) usageAccum.output_tokens = (usageAccum.output_tokens || 0) + parsed.output_tokens;
        if (parsed.cache_read_tokens != null) usageAccum.cache_read_tokens = (usageAccum.cache_read_tokens || 0) + parsed.cache_read_tokens;
        if (parsed.cache_write_tokens != null) usageAccum.cache_write_tokens = (usageAccum.cache_write_tokens || 0) + parsed.cache_write_tokens;
        if (parsed.ratelimit) usageAccum.ratelimit = parsed.ratelimit;
        break;

      case 'error_quota':
        quotaError = { message: parsed.message, ratelimit: parsed.ratelimit };
        break;

      case 'error':
        events.push({
          type: 'error',
          ts,
          content: { code: parsed.code, message: parsed.message, recoverable: false },
        });
        break;
    }
  }

  if (quotaError) {
    const meta = quotaError.ratelimit ? { ratelimit_headers: quotaError.ratelimit } : undefined;
    events.push({
      type: 'error',
      ts: now,
      content: { code: 'error_quota', message: quotaError.message, recoverable: false },
      ...(meta ? { meta } : {}),
    });
    events.push({ type: 'done', ts: now, content: { exit_code: exitCode, session_id: null } });
    return events;
  }

  if (exitCode !== 0 && !events.some(e => e.type === 'error')) {
    const stderr = (stderrBuf || '').trim();
    const isQuota = /quota|rate.?limit|premium.?request/i.test(stderr);
    const isAuth = /401|unauthorized|auth/i.test(stderr);
    const isTransient = !isQuota && classifyTransientError(stderr).kind === 'transient';
    if (isQuota) {
      events.push({
        type: 'error',
        ts: now,
        content: { code: 'error_quota', message: stderr || 'Premium request quota exhausted', recoverable: false },
      });
    } else {
      events.push({
        type: 'error',
        ts: now,
        content: {
          code: isAuth ? 'error_auth' : (isTransient ? 'error_transient' : 'error_unknown'),
          message: stderr || `copilot exited with code ${exitCode}`,
          recoverable: isTransient,
        },
      });
    }
  }

  if (finishReason && COPILOT_TRUNCATED_REASONS.has(finishReason) && !enableStopReasonFallback) {
    events.push({
      type: 'assistant_text', ts: now, role: 'assistant',
      content: { text: `\n\n⚠ Truncated (finish_reason=${finishReason}) — enable enableStopReasonFallback for auto-continuation\n` },
    });
  }

  const usageMeta = usageAccum.ratelimit ? { ratelimit_headers: usageAccum.ratelimit } : undefined;
  events.push({
    type: 'usage',
    ts: now,
    content: {
      input_tokens: usageAccum.input_tokens,
      output_tokens: usageAccum.output_tokens,
      cache_read_tokens: usageAccum.cache_read_tokens,
      cache_write_tokens: usageAccum.cache_write_tokens,
      cost_usd: null,
    },
    ...(usageMeta ? { meta: usageMeta } : {}),
  });

  events.push({
    type: 'done', ts: now,
    content: { exit_code: exitCode, session_id: null, stop_reason: finishReason },
  });
  return events;
}

// ── Skills inline injection (gap #2 workaround) ───────────────────────────────

const INLINE_SKILLS = ['caveman', 'interrogate', 'strict-assessment'];

/**
 * When capabilities.skillsRuntime=false, prepend verbatim SKILL.md content for
 * each skill so the model receives the same behaviour instructions it would get
 * from the Claude Code skills runtime.
 *
 * skillsDir: absolute path to the harness `skills/` directory.
 *   Defaults to three levels up from this file's location (harness root) / skills.
 * Returns the augmented prompt string.
 */
function injectSkillsInline(prompt, skillsDir) {
  if (capabilities.skillsRuntime) return prompt;
  const dir = skillsDir || path.join(__dirname, '..', '..', '..', 'skills');
  const sections = [];
  for (const skill of INLINE_SKILLS) {
    const skillPath = path.join(dir, skill, 'SKILL.md');
    try {
      const content = fs.readFileSync(skillPath, 'utf8').trim();
      if (content) sections.push(`<!-- skill:${skill} -->\n${content}`);
    } catch { /* skill file absent — skip silently */ }
  }
  if (!sections.length) return prompt;
  return sections.join('\n\n') + '\n\n' + prompt;
}

// ── Cleanup helper ────────────────────────────────────────────────────────────

function cleanupLogDir(logDir) {
  if (!logDir) return;
  try {
    for (const f of fs.readdirSync(logDir)) {
      try { fs.unlinkSync(path.join(logDir, f)); } catch {}
    }
    fs.rmdirSync(logDir);
  } catch {}
}

module.exports = {
  id: 'github-copilot',
  capabilities,
  supportsFeature,
  probe,
  loginInstructions,
  spawnCopilot,
  parseStream,
  cleanupLogDir,
  injectSkillsInline,
  registerHook,
  // exposed for unit tests
  _parseCopilotLogEntry: parseCopilotLogEntry,
  _readLogDirJsonl: readLogDirJsonl,
  _clearHooks: clearHooks,
};
