'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Provider = require('./Provider');

const ROOT = path.join(__dirname, '..', '..', '..', '..', '..');
const HARNESS = path.join(__dirname, '..', '..', '..', '..');

// Mirrors run-agent.js model constants so spawn() uses the same defaults when
// called without a pre-resolved modelArgs (e.g. from tests).
const LATEST_SONNET = 'claude-sonnet-4-6';

const TOKEN_RESET_REGEX = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const NETWORK_ERROR_REGEX = /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|network (?:error|unavailable|is unreachable)|socket hang up|TLS (?:handshake|connection)|connect ECONN|Unable to (?:reach|connect)|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i;
const { classifyTokenError, classifyTransientError, classifyModelAvailabilityError } = require('../token-error');

const MAX_CONTINUATIONS = 3;

function detectTokenReset(buf) {
  const m = (buf || '').match(TOKEN_RESET_REGEX);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: m[2] ? parseInt(m[2], 10) : 0, ampm: m[3] ? m[3].toLowerCase() : null, tz: m[4] ? m[4].trim() : null };
}

function detectNetworkError(buf) {
  if (!buf) return false;
  if (TOKEN_RESET_REGEX.test(buf)) return false;
  return NETWORK_ERROR_REGEX.test(buf);
}

function cleanupHarnessSessionFile(sessionId) {
  if (!sessionId) return;
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return;
    for (const entry of fs.readdirSync(projectsDir)) {
      const f = path.join(projectsDir, entry, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch {} }
    }
  } catch {}
}

class ClaudeCodeProvider extends Provider {
  constructor(config = {}) {
    super();
    this._config = config;
  }

  get id() { return 'claude-code'; }

  async probe() {
    const { spawnSync } = require('child_process');
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    return r.status === 0;
  }

  loginInstructions() {
    return 'Run `claude` in your terminal and complete the login flow, then retry.';
  }

  get capabilities() {
    return {
      planMode: true,
      skillsRuntime: true,
      subAgents: true,
      autoResume: true,
      streamJson: true,
      hooks: true,
      permissionMode: true,
    };
  }

  parseStream(chunk) {
    if (!chunk || !chunk.trim()) return null;
    try {
      const obj = JSON.parse(chunk);
      if (obj.type === 'assistant' && obj.message) {
        const texts = (obj.message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        if (texts) return { type: 'assistant_text', text: texts, usage: obj.message.usage || null, stopReason: obj.message.stop_reason || null };
      }
      if (obj.type === 'result') return { type: 'done', costUsd: obj.cost_usd ?? null, usage: obj.usage ?? null, stopReason: obj.stop_reason || null };
      if (obj.type === 'system' && obj.subtype === 'init') return { type: 'init', model: obj.model || null };
    } catch {}
    return null;
  }

  /**
   * Core spawn logic extracted verbatim from run-agent.js `runClaude()`.
   * Accepts pre-resolved modelArgs/effortEnv/etc. via opts to stay compatible
   * with existing call sites; also accepts raw config for standalone use.
   *
   * opts: { silent, label, role, modelArgs, effortEnv, fallbackNote, effortNote,
   *         streamOutput, heartbeatMs, prespawnHeartbeatMs, cliWatchdogMs,
   *         maxAttempts, backoffMs }
   */
  async spawn(payload, opts = {}) {
    let {
      silent = false,
      label = 'provider:claude-code',
      modelArgs = ['--model', LATEST_SONNET],
      effortEnv = {},
      fallbackNote = null,
      effortNote = null,
      streamOutput = true,
      heartbeatMs = 5000,
      prespawnHeartbeatMs = 5000,
      cliWatchdogMs = 5000,
      maxAttempts = 5,
      backoffMs = [1000, 4000, 10000, 30000, 60000],
      stopReasonFallback = false,
    } = opts;

    const doStream = !silent && streamOutput;

    const attempt = (payloadOverride) => new Promise((resolve, reject) => {
      const textChunks = [];
      let detectedModel = modelArgs[1] || null;
      let usage = null;
      let costUsd = null;
      let stopReason = null;
      let lineBuffer = '';
      let heartbeatTimer;
      let stderrBuf = '';
      let stdoutBuf = '';
      let firstByteSeen = false;
      let lastCliWriteAt = Date.now();

      const bumpCliWrite = () => { lastCliWriteAt = Date.now(); };

      const resetHeartbeat = () => {
        clearTimeout(heartbeatTimer);
        const interval = firstByteSeen ? heartbeatMs : prespawnHeartbeatMs;
        heartbeatTimer = setTimeout(() => {
          process.stdout.write(`[${label}] still working...\n`);
          bumpCliWrite();
          resetHeartbeat();
        }, interval);
      };

      const markFirstByte = () => {
        if (!firstByteSeen) {
          firstByteSeen = true;
          if (doStream) resetHeartbeat();
        }
      };

      const cliWatchdogTimer = doStream ? setInterval(() => {
        if (Date.now() - lastCliWriteAt >= cliWatchdogMs) {
          process.stdout.write(`[${label}] still working...\n`);
          bumpCliWrite();
        }
      }, 1000) : null;
      if (cliWatchdogTimer && cliWatchdogTimer.unref) cliWatchdogTimer.unref();

      if (doStream) resetHeartbeat();

      const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const args = ['--print', '--session-id', sessionId, '--output-format', 'stream-json', '--verbose', ...modelArgs];
      const harnessSessionDir = path.join(HARNESS, '.state', 'sessions', sessionId);
      try { fs.mkdirSync(harnessSessionDir, { recursive: true }); } catch {}

      const child = spawn('claude', args, {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...effortEnv, CLAUDE_SESSION_DIR: harnessSessionDir, ANTHROPIC_PROJECT_DIR: harnessSessionDir },
      });
      child.stdin.write(payloadOverride != null ? payloadOverride : payload, 'utf8');
      child.stdin.end();

      child.stdout.on('data', data => {
        markFirstByte();
        if (doStream && heartbeatTimer) resetHeartbeat();
        const chunk = data.toString();
        stdoutBuf += chunk;
        if (stdoutBuf.length > 8000) stdoutBuf = stdoutBuf.slice(-8000);
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'system' && obj.subtype === 'init') {
              if (!detectedModel && obj.model) detectedModel = obj.model;
            } else if (obj.type === 'assistant' && obj.message) {
              if (obj.message.model) detectedModel = obj.message.model;
              if (obj.message.usage) usage = obj.message.usage;
              if (obj.message.stop_reason) stopReason = obj.message.stop_reason;
              for (const block of (obj.message.content || [])) {
                if (block.type === 'text') {
                  textChunks.push(block.text);
                  if (doStream) { process.stdout.write(block.text); bumpCliWrite(); }
                }
              }
            } else if (obj.type === 'result') {
              if (obj.cost_usd != null) costUsd = obj.cost_usd;
              if (obj.usage) usage = obj.usage;
              if (obj.stop_reason) stopReason = obj.stop_reason;
              if (textChunks.length === 0 && obj.result) textChunks.push(obj.result);
            }
          } catch {}
        }
      });

      child.stderr.on('data', data => {
        markFirstByte();
        const chunk = data.toString();
        stderrBuf += chunk;
        if (stderrBuf.length > 32000) stderrBuf = stderrBuf.slice(-32000);
        if (doStream && heartbeatTimer) resetHeartbeat();
      });

      child.on('close', code => {
        clearTimeout(heartbeatTimer);
        if (cliWatchdogTimer) clearInterval(cliWatchdogTimer);
        if (doStream) process.stdout.write('\n');
        cleanupHarnessSessionFile(sessionId);
        if (code !== 0) {
          const err = new Error(`Claude exited with code ${code}`);
          const combined = stderrBuf + '\n' + stdoutBuf;
          // Permanent "selected model unavailable" errors must win over any noisy
          // 429/5xx substring in the same buffer, otherwise the retry loop burns
          // attempts on a non-retryable failure. Check FIRST and short-circuit.
          const modelAvail = classifyModelAvailabilityError(combined);
          if (modelAvail.kind === 'model-unavailable') {
            err.modelUnavailable = true;
            err.attemptedModel = modelAvail.model || (modelArgs && modelArgs[1]) || null;
            err.transientError = false;
            err.networkError = false;
            reject(err);
            return;
          }
          // Reset-time presence wins over the "monthly spend limit" phrase — the same
          // message has been observed for a 5-hour session limit. Only mark monthlyCapHit
          // when there is genuinely no parseable reset time anywhere in stderr/stdout.
          const reset = detectTokenReset(combined);
          if (reset) {
            err.tokenReset = reset;
          } else {
            const tokenClass = classifyTokenError(combined);
            if (tokenClass.kind === 'monthly') {
              err.monthlyCapHit = true;
            } else {
              err.networkError = detectNetworkError(combined);
              if (!err.networkError) {
                const t = classifyTransientError(combined);
                if (t.kind === 'transient') err.transientError = true;
              }
            }
          }
          reject(err);
        } else {
          resolve({ text: textChunks.join(''), model: detectedModel, usage, costUsd, fallbackNote, effortNote, stopReason });
        }
      });

      child.on('error', err => {
        clearTimeout(heartbeatTimer);
        if (cliWatchdogTimer) clearInterval(cliWatchdogTimer);
        cleanupHarnessSessionFile(sessionId);
        if (!err.networkError) err.networkError = detectNetworkError(String(err && err.message || ''));
        reject(err);
      });
    });

    // One-shot fallback used by runWithRetry when the CLI reports the selected
    // model is unavailable. Mutates modelArgs in place so any subsequent retry/
    // continuation uses the fallback model too, and tags the result with a
    // visible fallbackNote so users see the substitution in the usage footer.
    let modelFallbackUsed = false;
    const tryModelFallback = async (payloadOverride, originalErr) => {
      if (modelFallbackUsed) return null;
      const attempted = originalErr.attemptedModel || (modelArgs && modelArgs[1]) || 'unknown';
      if (attempted === LATEST_SONNET) return null;
      modelFallbackUsed = true;
      const note = `model "${attempted}" unavailable → fell back to ${LATEST_SONNET}`;
      process.stdout.write(`[${label}] ${note}\n`);
      // Map-replace only the value AFTER `--model` so any extra CLI flags
      // (future-proofing: e.g. `--some-flag` appended by callers) survive the
      // fallback. Whole-array reassignment used to silently drop them.
      const mi = modelArgs.indexOf('--model');
      if (mi >= 0 && mi + 1 < modelArgs.length) {
        modelArgs = modelArgs.slice();
        modelArgs[mi + 1] = LATEST_SONNET;
      } else {
        modelArgs = ['--model', LATEST_SONNET];
      }
      try {
        const result = await attempt(payloadOverride);
        const prior = result.fallbackNote ? `${result.fallbackNote}; ` : '';
        result.fallbackNote = prior + note;
        return result;
      } catch (e) {
        e.modelFallbackFailed = true;
        e.attemptedModel = attempted;
        throw e;
      }
    };

    const runWithRetry = async (payloadOverride) => {
      for (let attemptNum = 0; attemptNum < maxAttempts; attemptNum++) {
        try {
          return await attempt(payloadOverride);
        } catch (err) {
          // Model-unavailable is permanent: try Sonnet fallback ONCE, then surface
          // an actionable error rather than the cryptic "exited with code 1".
          if (err && err.modelUnavailable && !modelFallbackUsed) {
            try {
              const fb = await tryModelFallback(payloadOverride, err);
              if (fb) return fb;
            } catch (fbErr) {
              const id = fbErr.attemptedModel || 'unknown';
              fbErr.message = `Selected model "${id}" is unavailable for this account/provider. Edit topic-config.json \`models.<role>\` or run \`node src/run-agent.js --model\` to pick a supported id. (Sonnet fallback also failed: ${fbErr.message})`;
              throw fbErr;
            }
          }
          if (err && err.modelUnavailable) {
            const id = err.attemptedModel || (modelArgs && modelArgs[1]) || 'unknown';
            err.message = `Selected model "${id}" is unavailable for this account/provider. Edit topic-config.json \`models.<role>\` or run \`node src/run-agent.js --model\` to pick a supported id.`;
            throw err;
          }
          const retryable = err && (err.networkError || err.transientError);
          if (!retryable || attemptNum >= maxAttempts - 1) throw err;
          const base = backoffMs[Math.min(attemptNum, backoffMs.length - 1)] || 0;
          const delay = Math.round(base * (0.5 + Math.random() * 0.5));
          const kind = err.transientError ? 'transient API error' : 'network error';
          process.stdout.write(`[${label}] ${kind} (attempt ${attemptNum + 1}/${maxAttempts}): ${err.message} — retrying in ${Math.round(delay / 1000)}s\n`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    };

    let result = await runWithRetry();
    let pauseContinuations = 0;
    let maxTokenContinuations = 0;

    // pause_turn resume: per Anthropic API, must re-send prior assistant turn so
    // the model continues from its own output. Re-sending bare payload restarts
    // from scratch -> duplicate output. Wrap prior text as continuation context.
    while (result && result.stopReason === 'pause_turn' && pauseContinuations < MAX_CONTINUATIONS) {
      pauseContinuations += 1;
      process.stdout.write(`[${label}] stop_reason=pause_turn — resuming (${pauseContinuations}/${MAX_CONTINUATIONS})\n`);
      const priorText = result.text || '';
      const contPayload = `${payload}\n\n<prior-assistant-output>\n${priorText}\n</prior-assistant-output>\n\nContinue from exactly where you left off; do not repeat content.`;
      const next = await runWithRetry(contPayload);
      result.text = priorText + (next.text || '');
      result.usage = next.usage || result.usage;
      result.stopReason = next.stopReason;
    }

    if (stopReasonFallback) {
      while (result && result.stopReason === 'max_tokens' && maxTokenContinuations < MAX_CONTINUATIONS) {
        maxTokenContinuations += 1;
        process.stdout.write(`[${label}] stop_reason=max_tokens — auto-continuing (${maxTokenContinuations}/${MAX_CONTINUATIONS})\n`);
        const priorText = result.text || '';
        const contPayload = `${payload}\n\n<prior-assistant-output>\n${priorText}\n</prior-assistant-output>\n\nContinue from exactly where you left off; do not repeat content.`;
        const next = await runWithRetry(contPayload);
        result.text = priorText + (next.text || '');
        result.usage = next.usage || result.usage;
        result.stopReason = next.stopReason;
      }
    }

    // Always banner when loop exits with non-end_turn stop_reason (cap hit or fallback off).
    if (result && result.stopReason && result.stopReason !== 'end_turn' && result.stopReason !== 'tool_use') {
      const capHit =
        (result.stopReason === 'pause_turn' && pauseContinuations >= MAX_CONTINUATIONS) ||
        (result.stopReason === 'max_tokens' && (stopReasonFallback ? maxTokenContinuations >= MAX_CONTINUATIONS : true));
      if (capHit) {
        const banner = stopReasonFallback || result.stopReason === 'pause_turn'
          ? `\n\n⚠ Continuation cap exhausted (stop_reason=${result.stopReason}, MAX_CONTINUATIONS=${MAX_CONTINUATIONS})\n`
          : `\n\n⚠ Truncated (stop_reason=max_tokens) — enable enableStopReasonFallback for auto-continuation\n`;
        result.text = (result.text || '') + banner;
      }
    }

    if (result) {
      result.continuations = pauseContinuations + maxTokenContinuations;
      result.pauseContinuations = pauseContinuations;
      result.maxTokenContinuations = maxTokenContinuations;
    }
    return result;
  }
}

module.exports = ClaudeCodeProvider;
