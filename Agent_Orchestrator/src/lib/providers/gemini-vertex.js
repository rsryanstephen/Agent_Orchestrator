'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Vertex AI provider (auth surface 3 from §13 of provider-abstraction-design.md)
//
// This module drives Gemini via Google Cloud Vertex AI using Application Default
// Credentials (ADC) rather than an AI Studio API key. It is intentionally
// separate from gemini.js (which covers AI Studio + Code Assist OAuth) so the
// correct auth surface is explicit in global-config.json:
//
//   "provider": "gemini-vertex"
//
// Prerequisites:
//   • GOOGLE_CLOUD_PROJECT env var set to a GCP project with Vertex AI enabled.
//   • ADC configured: run `gcloud auth application-default login` once.
//   • IAM role: roles/aiplatform.user on the project.
//
// [NEEDS-VERIFICATION] Vertex AI invocation details (--vertex flag, exact spawn
// args, JSONL log format) are assumptions based on available documentation.
// Probe `gemini --help` on a machine with both GOOGLE_CLOUD_PROJECT and ADC
// set to confirm the correct flag set before relying on this module.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { classifyTransientError } = require('../token-error');

const VERTEX_TRUNCATED_REASONS = new Set(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'length']);

// Re-use the same JSONL parser and event synthesis from the base gemini module.
// Vertex AI log entries are expected to share the same schema as AI Studio.
const {
  _parseGeminiLogEntry: parseGeminiLogEntry,
  _readLogDirJsonl: readLogDirJsonl,
} = require('./gemini');

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

// ── ADC availability check ────────────────────────────────────────────────────

/**
 * Returns true if ADC credentials file exists at the default location.
 * Does not validate the credentials are current/valid — only file presence.
 */
function adcFileExists() {
  const adcPath = path.join(
    os.homedir(),
    '.config', 'gcloud', 'application_default_credentials.json'
  );
  return fs.existsSync(adcPath);
}

// ── Auth probe ────────────────────────────────────────────────────────────────

function probe() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    process.stderr.write(
      '[WARN] gemini-vertex provider: GOOGLE_CLOUD_PROJECT env var is not set. ' +
      'Set it to your GCP project id and ensure Vertex AI API is enabled.\n'
    );
    return false;
  }

  if (!adcFileExists()) {
    process.stderr.write(
      '[WARN] gemini-vertex provider: Application Default Credentials not found. ' +
      'Run "gcloud auth application-default login" to configure ADC.\n'
    );
    return false;
  }

  // [NEEDS-VERIFICATION] Assumes `gemini --vertex --version` or plain `gemini --version`
  // works with ADC. The --vertex flag may not exist; the CLI may auto-detect Vertex from env.
  const bin = 'gemini';
  let r = spawnSync(bin, ['--version'], {
    shell: false,
    timeout: 8000,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env },
  });
  if (r.error && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL') && process.platform === 'win32') {
    r = spawnSync('gemini.cmd', ['--version'], {
      shell: true,
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env },
    });
  }
  return r.status === 0 && !r.error;
}

function loginInstructions() {
  return (
    'Gemini Vertex AI provider requires:\n' +
    '  1. GOOGLE_CLOUD_PROJECT env var set to your GCP project id.\n' +
    '  2. Vertex AI API enabled: gcloud services enable aiplatform.googleapis.com\n' +
    '  3. IAM role: roles/aiplatform.user on the project.\n' +
    '  4. ADC credentials: run "gcloud auth application-default login".\n' +
    '  5. Gemini CLI installed: npm i -g @google/gemini-cli\n' +
    '[NEEDS-VERIFICATION] Confirm "gemini --version" works with GOOGLE_CLOUD_PROJECT set.'
  );
}

// ── Resolve binary ────────────────────────────────────────────────────────────

function resolveGeminiBin() {
  if (process.platform !== 'win32') return { bin: 'gemini', shell: false };
  const r = spawnSync('gemini', ['--version'], { shell: false, timeout: 3000, encoding: 'utf8', windowsHide: true });
  if (!r.error) return { bin: 'gemini', shell: false };
  return { bin: 'gemini.cmd', shell: true };
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

/**
 * Spawn the Gemini CLI for a Vertex AI agent run.
 * opts: { prompt, model?, cwd? }
 *
 * [NEEDS-VERIFICATION] --vertex flag existence and exact arg shape for Vertex AI.
 * The CLI may auto-detect Vertex from GOOGLE_CLOUD_PROJECT env without a flag.
 */
function spawn_(opts) {
  const { prompt, model, cwd } = opts || {};
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-vertex-harness-'));

  // [NEEDS-VERIFICATION] --vertex flag assumed; may not exist in all CLI versions.
  // [NEEDS-VERIFICATION] --yolo and --log-dir support must be confirmed.
  const args = ['-p', String(prompt), '--yolo', '--log-dir', logDir];
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    // [NEEDS-VERIFICATION] Some CLI versions may use --project instead of --vertex.
    args.push('--vertex');
  }
  if (model && model.trim()) args.push('--model', model.trim());

  const { bin, shell } = resolveGeminiBin();
  const child = spawn(bin, args, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
    windowsHide: true,
    env: { ...process.env },
  });

  let _stdoutBuf = '';
  if (child.stdout) child.stdout.on('data', d => { _stdoutBuf += d.toString(); });

  const waitForExit = () => new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  return { child, logDir, waitForExit, getStdout: () => _stdoutBuf };
}

// ── parseStream ───────────────────────────────────────────────────────────────

function parseStream(exitCode, logDir, stderrBuf, stdoutBuf, opts) {
  const now = Date.now();
  const events = [];
  const enableStopReasonFallback = !!(opts && opts.enableStopReasonFallback);
  let finishReason = null;

  if (exitCode !== 0 && (!logDir || !fs.existsSync(logDir))) {
    const isAuth = /401|unauthorized|auth|adc|credentials|project/i.test(stderrBuf || '');
    events.push({
      type: 'error',
      ts: now,
      content: {
        code: isAuth ? 'error_auth' : 'error_spawn',
        message: (stderrBuf || '').trim() || 'gemini-vertex process failed to start',
        recoverable: false,
      },
    });
    events.push({ type: 'done', ts: now, content: { exit_code: exitCode, session_id: null } });
    return events;
  }

  const rawEntries = readLogDirJsonl(logDir || '');

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
          type: 'assistant_text', ts, role: 'assistant',
          content: { text: parsed.text },
          meta: parsed.model ? { model: parsed.model } : undefined,
        });
        break;
      case 'tool_call':
        events.push({
          type: 'tool_call', ts, role: 'assistant',
          content: { id: parsed.id, name: parsed.name, input: parsed.input },
        });
        break;
      case 'tool_result':
        events.push({
          type: 'tool_result', ts, role: 'tool',
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
          type: 'error', ts,
          content: { code: parsed.code, message: parsed.message, recoverable: false },
        });
        break;
    }
  }

  if (quotaError) {
    const meta = quotaError.ratelimit ? { ratelimit_headers: quotaError.ratelimit } : undefined;
    events.push({
      type: 'error', ts: now,
      content: { code: 'error_quota', message: quotaError.message, recoverable: false },
      ...(meta ? { meta } : {}),
    });
    events.push({ type: 'done', ts: now, content: { exit_code: exitCode, session_id: null } });
    return events;
  }

  if (exitCode !== 0 && !events.some(e => e.type === 'error')) {
    const stderr = (stderrBuf || '').trim();
    const isQuota = /quota|rate.?limit/i.test(stderr);
    const isAuth = /401|unauthorized|auth|credentials|adc|project/i.test(stderr);
    const isTransient = !isQuota && classifyTransientError(stderr).kind === 'transient';
    events.push({
      type: 'error', ts: now,
      content: {
        code: isQuota ? 'error_quota' : (isAuth ? 'error_auth' : (isTransient ? 'error_transient' : 'error_unknown')),
        message: stderr || `gemini-vertex exited with code ${exitCode}`,
        recoverable: isTransient,
      },
    });
  }

  if (finishReason && VERTEX_TRUNCATED_REASONS.has(finishReason) && !enableStopReasonFallback) {
    events.push({
      type: 'assistant_text', ts: now, role: 'assistant',
      content: { text: `\n\n⚠ Truncated (finish_reason=${finishReason}) — enable enableStopReasonFallback for auto-continuation\n` },
    });
  }

  const usageMeta = usageAccum.ratelimit ? { ratelimit_headers: usageAccum.ratelimit } : undefined;
  events.push({
    type: 'usage', ts: now,
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
    type: 'done', ts: now,
    content: { exit_code: exitCode, session_id: null, stop_reason: finishReason },
  });
  return events;
}

// ── Skills inline injection (gap #3 workaround) ───────────────────────────────

// Full set of skills that can be injected inline. registry.js filters this list
// down to the subset enabled by global-config.json flags before calling.
const INLINE_SKILLS = ['caveman', 'interrogate', 'strict-assessment', 'karpathy-guidelines'];

// enabledSkills: optional array filtered by registry from global-config flags.
function injectSkillsInline(prompt, enabledSkills, skillsDir) {
  // Support legacy two-arg call (prompt, skillsDir) where enabledSkills was absent
  if (typeof enabledSkills === 'string' || enabledSkills == null && typeof skillsDir === 'undefined') {
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

// ── Cleanup ───────────────────────────────────────────────────────────────────

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
  id: 'gemini-vertex',
  capabilities,
  supportsFeature,
  probe,
  loginInstructions,
  spawn: spawn_,
  parseStream,
  cleanupLogDir,
  injectSkillsInline,
  // exposed for unit tests
  _adcFileExists: adcFileExists,
};
