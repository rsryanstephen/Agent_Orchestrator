'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { classifyTransientError } = require('../token-error');

// Gemini API finish_reason values that indicate truncation/non-natural stop.
// STOP/end_turn = natural completion.
const GEMINI_TRUNCATED_REASONS = new Set(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'length']);

// ── Schema assumptions ────────────────────────────────────────────────────────
// [NEEDS-VERIFICATION] All field names in parseGeminiLogEntry() are based on
// planning-agent assumptions about the standalone `@google/gemini-cli` (post
// knowledge-cutoff). Probe `gemini --help` and inspect a sample `--log-dir`
// run before trusting these mappings. Only patch this function.

function parseGeminiLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const t = entry.type;
  if (!t) return null;

  if (t === 'message' || t === 'text' || t === 'assistant' || t === 'assistant_message') {
    const text = entry.text || entry.content || entry.message || '';
    if (!text && typeof entry.content !== 'string') return null;
    const finishReason = entry.finish_reason || entry.finishReason || entry.stop_reason || null;
    return { kind: 'assistant_text', text: String(text), model: entry.model || null, finishReason };
  }

  if (t === 'tool_call' || t === 'tool_use' || t === 'function_call') {
    return {
      kind: 'tool_call',
      id: entry.id || entry.tool_id || entry.call_id || '',
      name: entry.name || entry.tool_name || entry.function_name || '',
      input: entry.input || entry.arguments || entry.parameters || {},
    };
  }

  if (t === 'tool_result' || t === 'tool_response' || t === 'function_result') {
    const raw = entry.output || entry.content || entry.result || '';
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const output = str.length > 65536 ? str.slice(0, 65536) + '[TRUNCATED]' : str;
    return {
      kind: 'tool_result',
      call_id: entry.call_id || entry.tool_use_id || entry.id || '',
      output,
      is_error: !!(entry.is_error || entry.error),
    };
  }

  if (t === 'usage' || t === 'token_usage' || t === 'tokens') {
    return {
      kind: 'usage',
      input_tokens: entry.input_tokens ?? entry.prompt_tokens ?? null,
      output_tokens: entry.output_tokens ?? entry.completion_tokens ?? null,
      ratelimit: extractRateLimitFields(entry),
    };
  }

  if (
    t === 'quota_exceeded' || t === 'rate_limit_exceeded' ||
    t === 'error_quota' ||
    (t === 'error' && /quota|rate.?limit|api.?key/i.test(entry.message || ''))
  ) {
    return {
      kind: 'error_quota',
      message: entry.message || 'Gemini API quota exhausted',
      ratelimit: extractRateLimitFields(entry),
    };
  }

  if (t === 'error') {
    const isAuth = /401|unauthorized|auth|api.?key/i.test(entry.message || '');
    return {
      kind: 'error',
      code: isAuth ? 'error_auth' : (entry.code || 'error_unknown'),
      message: entry.message || 'Unknown error',
    };
  }

  return null;
}

// Pull x-ratelimit-* values from a log entry (headers may surface in the JSONL).
// [NEEDS-VERIFICATION] field path is assumed — patch if CLI surfaces them differently.
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

// ── Auth surface detection (§13 of provider-abstraction-design.md) ───────────

/**
 * Detect which Gemini auth surface is active.
 * Returns 'ai-studio' | 'code-assist' | 'vertex-redirect' | 'unknown'.
 *
 * Priority (per §13):
 *   1. GEMINI_API_KEY set          → 'ai-studio'
 *   2. GOOGLE_CLOUD_PROJECT set    → 'vertex-redirect' (wrong provider; user should use gemini-vertex)
 *   3. neither                     → 'code-assist' (assume `gemini auth` ran) or 'unknown'
 */
function detectAuthSurface() {
  if (process.env.GEMINI_API_KEY) return 'ai-studio';
  if (process.env.GOOGLE_CLOUD_PROJECT) return 'vertex-redirect';
  return 'code-assist';
}

// ── Auth probe ────────────────────────────────────────────────────────────────

function probe() {
  // Vertex AI ADC path belongs to gemini-vertex provider, not this one.
  if (detectAuthSurface() === 'vertex-redirect') {
    process.stderr.write(
      '[WARN] gemini provider: GOOGLE_CLOUD_PROJECT is set but no GEMINI_API_KEY. ' +
      'Vertex AI ADC auth requires the "gemini-vertex" provider. ' +
      'Set "provider": "gemini-vertex" in global-config.json.\n'
    );
    return false;
  }

  const bin = 'gemini';
  let r = spawnSync(bin, ['--version'], {
    shell: false,
    timeout: 8000,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL') && process.platform === 'win32') {
    r = spawnSync('gemini.cmd', ['--version'], {
      shell: true,
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  if (r.status === 0 && !r.error) {
    const surface = detectAuthSurface();
    if (surface === 'code-assist') {
      process.stderr.write(
        '[INFO] gemini provider: no GEMINI_API_KEY detected; assuming Google Workspace Code Assist OAuth ' +
        '(run "gemini auth" once if not already authenticated).\n'
      );
    }
    return true;
  }
  return false;
}

function loginInstructions() {
  return (
    'Install Gemini CLI: "npm i -g @google/gemini-cli". ' +
    'Auth options:\n' +
    '  • AI Studio API key: set GEMINI_API_KEY env var (https://aistudio.google.com/apikey).\n' +
    '  • Google Workspace Code Assist: run "gemini auth" once (browser OAuth).\n' +
    '  • Vertex AI ADC: set GOOGLE_CLOUD_PROJECT and use "provider": "gemini-vertex" instead.\n' +
    'Verify with "gemini --version".'
  );
}

// ── Hook registry (Gap #6: JS callbacks instead of settings.json hook dispatch) ─

const _preHooks = [];
const _postHooks = [];

/**
 * Register a pre- or post-spawn callback.
 * phase: 'pre' fires before the gemini process is spawned.
 * phase: 'post' fires after the child exits.
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

function resolveGeminiBin() {
  if (process.platform !== 'win32') return { bin: 'gemini', shell: false };
  const r = spawnSync('gemini', ['--version'], { shell: false, timeout: 3000, encoding: 'utf8', windowsHide: true });
  if (!r.error) return { bin: 'gemini', shell: false };
  return { bin: 'gemini.cmd', shell: true };
}

/**
 * Spawn the gemini CLI for one agent run.
 * opts: { prompt, model?, cwd?, silent? }
 * Returns { child, logDir, waitForExit, getStdout } where waitForExit() -> Promise<exitCode>.
 * Pre-hooks fire before spawn; post-hooks fire after child exits.
 * A heartbeat line "still working... (Ns)" is written to stdout every 5 s.
 */
function spawn_(opts) {
  const { prompt, model, cwd, silent } = opts || {};
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-harness-'));

  for (const fn of _preHooks) { try { fn(); } catch {} }

  // [NEEDS-VERIFICATION] --yolo is assumed to be the non-interactive/auto-approve flag.
  // [NEEDS-VERIFICATION] --log-dir support must be confirmed against `gemini --help`.
  const args = ['-p', String(prompt), '--yolo', '--log-dir', logDir];
  if (model && model.trim()) args.push('--model', model.trim());

  const { bin, shell } = resolveGeminiBin();
  const child = spawn(bin, args, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
    windowsHide: true,
  });

  // Capture stdout so parseStream can use it as a fallback when --log-dir is unsupported.
  let _stdoutBuf = '';
  if (child.stdout) child.stdout.on('data', d => { _stdoutBuf += d.toString(); });

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

  return { child, logDir, waitForExit, getStdout: () => _stdoutBuf };
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
 * Synthesize normalized events (§12) from post-exit gemini log-dir JSONL.
 * exitCode: process exit code from waitForExit().
 * logDir:   path written via --log-dir.
 * stderrBuf: accumulated stderr text (for error detection).
 * Returns array of normalized event objects.
 */
function parseStream(exitCode, logDir, stderrBuf, stdoutBuf, opts) {
  const now = Date.now();
  const events = [];
  const enableStopReasonFallback = !!(opts && opts.enableStopReasonFallback);
  let finishReason = null;

  // Handle spawn/auth failures before reading log dir.
  if (exitCode !== 0 && (!logDir || !fs.existsSync(logDir))) {
    const isAuth = /401|unauthorized|auth|api.?key/i.test(stderrBuf || '');
    events.push({
      type: 'error',
      ts: now,
      content: {
        code: isAuth ? 'error_auth' : 'error_spawn',
        message: (stderrBuf || '').trim() || 'gemini process failed to start',
        recoverable: false,
      },
    });
    events.push({ type: 'done', ts: now, content: { exit_code: exitCode, session_id: null } });
    return events;
  }

  const rawEntries = readLogDirJsonl(logDir || '');

  // --log-dir may be unsupported by the installed Gemini CLI version. If the log dir
  // produced no JSONL but stdout has content, treat stdout as the plain-text response.
  if (rawEntries.length === 0 && stdoutBuf && stdoutBuf.trim()) {
    const text = stdoutBuf.trim();
    events.push({ type: 'assistant_text', ts: now, role: 'assistant', content: { text } });
    events.push({
      type: 'usage',
      ts: now,
      content: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null },
    });
    events.push({ type: 'done', ts: now, content: { exit_code: exitCode, session_id: null } });
    return events;
  }

  let usageAccum = { input_tokens: null, output_tokens: null, ratelimit: null };
  let quotaError = null;

  for (const entry of rawEntries) {
    const parsed = parseGeminiLogEntry(entry);
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
    const isQuota = /quota|rate.?limit|api.?key/i.test(stderr);
    const isAuth = /401|unauthorized|auth|api.?key/i.test(stderr);
    const isTransient = classifyTransientError(stderr).kind === 'transient';
    if (isQuota) {
      events.push({
        type: 'error',
        ts: now,
        content: { code: 'error_quota', message: stderr || 'Gemini API quota exhausted', recoverable: false },
      });
    } else {
      events.push({
        type: 'error',
        ts: now,
        content: {
          code: isAuth ? 'error_auth' : (isTransient ? 'error_transient' : 'error_unknown'),
          message: stderr || `gemini exited with code ${exitCode}`,
          recoverable: isTransient,
        },
      });
    }
  }

  // Truncation banner — emit when finish_reason indicates non-natural stop and
  // auto-continuation is disabled. Gemini CLI is single-shot per spawn, so we
  // surface the state to the caller; orchestrator may re-prompt.
  if (finishReason && GEMINI_TRUNCATED_REASONS.has(finishReason) && !enableStopReasonFallback) {
    events.push({
      type: 'assistant_text',
      ts: now,
      role: 'assistant',
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
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost_usd: null,
    },
    ...(usageMeta ? { meta: usageMeta } : {}),
  });

  events.push({
    type: 'done',
    ts: now,
    content: { exit_code: exitCode, session_id: null, stop_reason: finishReason },
  });
  return events;
}

// ── Skills inline injection (gap #3 workaround) ───────────────────────────────

const INLINE_SKILLS = ['caveman', 'interrogate', 'strict-assessment'];

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
  id: 'gemini',
  capabilities,
  supportsFeature,
  probe,
  loginInstructions,
  spawn: spawn_,
  parseStream,
  cleanupLogDir,
  injectSkillsInline,
  registerHook,
  // exposed for unit tests
  _parseGeminiLogEntry: parseGeminiLogEntry,
  _readLogDirJsonl: readLogDirJsonl,
  _detectAuthSurface: detectAuthSurface,
  _clearHooks: clearHooks,
};
