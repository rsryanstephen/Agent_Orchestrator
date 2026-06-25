'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { classifyTransientError, classifyModelAvailabilityError } = require('../token-error');

// Harness root — three levels up from src/lib/providers/. Shared constant so
// global-config.json path derivation does not drift if files move.
const HARNESS = path.join(__dirname, '..', '..', '..');

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

// Checks whether the copilot binary is reachable by running --version.
// Separated from probe() so registry.js can distinguish binary-missing vs
// credentials-missing failure modes and offer targeted recovery.
function isBinaryInstalled() {
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

// Checks whether any supported GA auth credential is present.
// Returns true when ANY of these conditions hold:
//   (a) COPILOT_GITHUB_TOKEN env var is non-empty (set from .env loader in run-agent.js)
//   (b) `gh auth token` returns a token (GitHub CLI authenticated) — token is exported
//       into process.env.COPILOT_GITHUB_TOKEN so the spawned child inherits it
// Windows Credential Manager read removed: interactive /login does not persist headlessly.
// Generic GitHub tokens (GH_TOKEN, GITHUB_TOKEN) do not grant Copilot scope and are ignored.
// Detects obvious placeholder/template token values shipped in the sample .env
// (e.g. "github_pat_YOUR_ACTUAL_TOKEN_HERE"). probe() previously accepted any
// non-empty string, so a placeholder made the provider report "usable" then fail
// at runtime with 401 Bad credentials. Reject known placeholder markers so probe()
// reflects real usability. Real PATs may contain uppercase, so we match marker
// substrings rather than casing.
function _isPlaceholderToken(token) {
  const t = String(token || '').toLowerCase();
  const markers = ['your_', '_here', 'placeholder', 'example', 'xxxx', 'changeme', 'replace', 'actual_token', 'your-token', 'dummy'];
  return markers.some((m) => t.includes(m));
}

function _authCredentialsExist() {
  // (a) env var — fastest check, no subprocess. Set via .env file or CI environment.
  // Treat placeholder values as absent so probe() does not falsely report usable.
  const tokenEnv = process.env.COPILOT_GITHUB_TOKEN || '';
  if (tokenEnv.trim() && !_isPlaceholderToken(tokenEnv)) return true;

  // (b) gh CLI fallback — reads the token from the authenticated gh session.
  try {
    const r = spawnSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (r.status === 0 && !r.error) {
      const token = (r.stdout || '').trim();
      if (token) {
        process.env.COPILOT_GITHUB_TOKEN = token;
        return true;
      }
    }
  } catch {
    // gh not installed or not authenticated — fall through.
  }

  return false;
}

// Binary check AND credential check must both pass for the provider to be usable.
function probe() {
  return isBinaryInstalled() && _authCredentialsExist();
}

// Copilot CLI interactive auth entry point (stub). The GA copilot CLI does not
// support automated 'copilot auth login'; credentials must come from COPILOT_GITHUB_TOKEN
// env var or the interactive /login slash command run inside a copilot session.
// This function documents the path; in non-TTY contexts (CI/pipe), returns false and
// prints setup instructions rather than attempting an automated flow that won't work.
function autoLogin() {
  // Non-interactive guard: no automated auth path exists for Copilot.
  if (!process.stdout.isTTY) {
    console.error('\n[github-copilot] autoLogin: no interactive terminal detected.\n');
    console.error('[github-copilot] ' + loginInstructions() + '\n');
    return false;
  }
  // Even in interactive mode, there is no automated CLI path for Copilot auth.
  // The /login slash command requires a copilot session.
  console.error('\n[github-copilot] No automated CLI auth available for Copilot GA.\n');
  console.error('[github-copilot] ' + loginInstructions() + '\n');
  return false;
}

function loginInstructions() {
  const lines = [
    'GitHub Copilot CLI (GA, standalone) auth — two supported options:',
    '  (1) Fine-grained PAT (recommended): generate a github_pat_ token with "Copilot Requests: Read" permission',
    '      then add COPILOT_GITHUB_TOKEN="github_pat_..." to Agent_Orchestrator/.env (never commit this file).',
    '      Note: classic ghp_ tokens are rejected by the Copilot CLI — you must use a fine-grained PAT.',
    '  (2) GitHub CLI: run `gh auth login` — the harness reads the token via `gh auth token` automatically.',
    'Requires an active GitHub Copilot subscription (Pro: 300 premium req/mo; Business: 1500/mo).',
    'See README.md → "GitHub Copilot Provider Auth Setup" for step-by-step instructions.'
  ];
  return lines.join('\n');
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

// Cached result of flag-support probe: null = not yet probed.
let _toolsFlag = null;

// Probe 'copilot --help' once to determine whether --allow-builtin-tools is
// supported. Org Copilot policy blocks third-party MCP servers; --allow-builtin-tools
// restricts the CLI to built-in tools only and avoids the policy hard-exit.
// Falls back to --allow-all-tools for older CLI versions that lack the flag.
function _resolveToolsFlag(_spawnSyncFn) {
  if (_toolsFlag !== null) return _toolsFlag;
  try {
    const fn = _spawnSyncFn || spawnSync;
    const { bin, shell } = resolvecopilotBin();
    const r = fn(bin, ['--help'], { shell, timeout: 5000, encoding: 'utf8', windowsHide: true });
    const helpText = (r.stdout || '') + (r.stderr || '');
    _toolsFlag = helpText.includes('--allow-builtin-tools') ? '--allow-builtin-tools' : '--allow-all-tools';
  } catch {
    _toolsFlag = '--allow-all-tools';
  }
  return _toolsFlag;
}

/** Reset the cached tools-flag probe result (test helper). */
function _resetToolsFlag() { _toolsFlag = null; }

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
  // _configPath: test-only injection to override global-config.json path.
  const { prompt, model, mcpConfig, cwd, silent, _spawn: spawnFn = spawn, _spawnSync: spawnSyncFn, _configPath } = opts || {};
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-harness-'));

  // Prefix prompt with Copilot CLI slash commands from the copilot-cli-settings block in global-config.json.
  let effectivePrompt = String(prompt);
  try {
    const _gcfgPath = _configPath || path.join(HARNESS, 'global-config.json');
    const _cliSettings = (JSON.parse(fs.readFileSync(_gcfgPath, 'utf8'))['copilot-cli-settings']) || {};
    if (_cliSettings['memory'] && _cliSettings['memory'] !== 'off' && _cliSettings['memory'] !== 'none') {
      effectivePrompt = `/memory ${_cliSettings['memory']}\n\n${effectivePrompt}`;
    }
  } catch { /* config absent — skip prefix */ }

  for (const fn of _preHooks) { try { fn(); } catch {} }

  // Prompt is fed via stdin, not argv, to avoid ENAMETOOLONG on Windows.
  // Windows cmd.exe caps argv at ~8191 chars (shell:true path); large prompts with
  // injected inline-skills routinely exceed this. -p is omitted so copilot reads
  // the piped stdin as the non-interactive prompt input.
  const args = [_resolveToolsFlag(spawnSyncFn), '--log-dir', logDir];
  if (model && model.trim()) args.push('--model', model.trim());
  if (mcpConfig && fs.existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig);

  // Child inherits process.env — COPILOT_GITHUB_TOKEN already set by _authCredentialsExist()
  // (either from .env loader in run-agent.js or from `gh auth token` fallback).
  const childEnv = process.env;

  const { bin, shell } = resolvecopilotBin();
  const child = spawnFn(bin, args, {
    cwd: cwd || process.cwd(),
    // stdin=pipe so effectivePrompt can be written after spawn without touching argv.
    stdio: ['pipe', 'pipe', 'pipe'],
    shell,
    windowsHide: true,
    env: childEnv,
  });

  // Write prompt to stdin and close; suppress EPIPE if child exits before consuming all input.
  child.stdin.on('error', () => {});
  child.stdin.write(effectivePrompt, 'utf8');
  child.stdin.end();

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
    // Model-unavailable must win over noisy 429/5xx substrings — check before transient.
    const modelAvail = classifyModelAvailabilityError(stderr);
    if (modelAvail.kind === 'model-unavailable') {
      events.push({
        type: 'error',
        ts: now,
        content: { code: 'error_model_unavailable', message: stderr || 'Selected model is unavailable', attemptedModel: modelAvail.model, recoverable: false },
      });
    } else if (isQuota) {
      events.push({
        type: 'error',
        ts: now,
        content: { code: 'error_quota', message: stderr || 'Premium request quota exhausted', recoverable: false },
      });
    } else {
      const isTransient = classifyTransientError(stderr).kind === 'transient';
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

// Full set of skills that can be injected inline. registry.js filters this list
// down to the subset enabled by global-config.json flags before calling.
const INLINE_SKILLS = ['caveman', 'interrogate', 'strict-assessment', 'karpathy-guidelines'];

/**
 * When capabilities.skillsRuntime=false, prepend verbatim SKILL.md content for
 * each skill so the model receives the same behaviour instructions it would get
 * from the Claude Code skills runtime.
 *
 * enabledSkills: optional array of skill names to inject; defaults to INLINE_SKILLS.
 * skillsDir: absolute path to the harness `skills/` directory.
 *   Defaults to three levels up from this file's location (harness root) / skills.
 * Returns the augmented prompt string.
 */
function injectSkillsInline(prompt, enabledSkills, skillsDir) {
  // Legacy two-arg shim: injectSkillsInline(prompt, skillsDir) — shift args when
  // enabledSkills is a string path (old signature). Array/null/undefined falls through.
  if (typeof enabledSkills === 'string') {
    skillsDir = enabledSkills;
    enabledSkills = null;
  }
  if (capabilities.skillsRuntime) return prompt;
  const activeSkills = Array.isArray(enabledSkills) ? enabledSkills : INLINE_SKILLS;
  const dir = skillsDir || path.join(__dirname, '..', '..', '..', 'skills');
  const sections = [];
  for (const skill of activeSkills) {
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
  isBinaryInstalled,
  autoLogin,
  _authCredentialsExist,
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
  _resolveToolsFlag,
  _resetToolsFlag,
};
