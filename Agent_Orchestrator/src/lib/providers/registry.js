'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS = path.join(__dirname, '..', '..', '..', '..');
const GLOBAL_CONFIG_PATH = path.join(HARNESS, 'global-config.json');

// Derive the Claude Code project directory name from an absolute path — mirrors
// the naming convention Claude Code uses for ~/.claude/projects/<name>/:
//   1. forward-slash normalize  2. : → -  3. / → -  4. . → -  5. lowercase first char
function _claudeProjectDirName(absPath) {
  return absPath
    .replace(/\\/g, '/')
    .replace(/:/g, '-')
    .replace(/\//g, '-')
    .replace(/\./g, '-')
    .replace(/^(.)/, (c) => c.toLowerCase());
}

function _resolveMemoryMdPaths(_rootDir) {
  const projectDirName = _claudeProjectDirName(HARNESS);
  const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  return [path.join(claudeProjects, projectDirName, 'memory', 'MEMORY.md')];
}

// Adapt a module-style provider export (plain object with id/capabilities/probe/spawn/etc.)
// into a Provider-interface-compatible object with a full lifecycle spawn().
function _adaptModule(mod) {
  const spawnFn = mod.spawnCopilot || mod.spawn;
  return {
    get id() { return mod.id; },
    get capabilities() { return mod.capabilities; },
    probe: mod.probe ? (...a) => mod.probe(...a) : async () => false,
    loginInstructions: mod.loginInstructions ? () => mod.loginInstructions() : () => '',
    parseStream: mod.parseStream ? (chunk) => mod.parseStream(chunk) : () => null,
    registerHook: mod.registerHook ? (phase, fn) => mod.registerHook(phase, fn) : null,
    spawn: !spawnFn
      ? async () => { throw new Error(`${mod.id}: spawn not implemented`); }
      : async (payload, opts) => {
          const { cwd, modelArgs, fallbackNote, effortNote, silent } = opts || {};
          const rootDir = cwd || process.cwd();
          const model = Array.isArray(modelArgs) && modelArgs.length >= 2 ? modelArgs[1] : undefined;

          // Gap #2: enforce probe() before spawn() to catch auth mismatches early.
          // Three-step recovery: probe → autoLogin if binary present but creds missing → re-probe.
          if (typeof mod.probe === 'function') {
            let ok = mod.probe();
            let loginOk;
            if (!ok && typeof mod.isBinaryInstalled === 'function' && mod.isBinaryInstalled()) {
              if (typeof mod.autoLogin === 'function') {
                loginOk = mod.autoLogin();
              }
              ok = !!mod.probe();
            }
            if (!ok) {
              const hint = typeof mod.loginInstructions === 'function' ? mod.loginInstructions() : '';
              throw new Error(
                loginOk === true
                  ? `Provider "${mod.id}" — OAuth completed but credentials not found in ~/.copilot/. Re-run without custom flags.`
                  : `Provider "${mod.id}" failed pre-spawn probe — check auth/environment.\n` + (hint ? hint + '\n' : '')
              );
            }
          }

          // §2: inject skills inline for providers without native skillsRuntime.
          // Build enabledSkills list by consulting global-config.json flags so
          // only skills explicitly enabled by the user are prepended to the prompt.
          if (typeof mod.injectSkillsInline === 'function') {
            let _gcfg = {};
            try { _gcfg = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')); } catch {}
            const _skillFlagMap = {
              'caveman':             'use-caveman',
              'interrogate':         'use-interrogate',
              'strict-assessment':   'use-strict-assessment',
              'karpathy-guidelines': 'use-karpathy',
            };
            const enabledSkills = Object.entries(_skillFlagMap)
              .filter(([, flag]) => _gcfg[flag] !== false)
              .map(([skill]) => skill);
            payload = mod.injectSkillsInline(payload, enabledSkills);
          }

          // §7: generate AGENTS.md from CLAUDE.md + MEMORY.md before copilot spawn.
          const agentsMdGenerator = require('./agents-md-generator');
          // Load global config early so provide-native-config-to-agents can gate provider-native config injection.
          // When provide-native-config-to-agents is true, include the provider's own native config file in the
          // harness context (then suppress the original so it isn't double-loaded by the provider).
          // When false, still suppress Copilot/Gemini native configs for harness isolation.
          const _spawnCfg = _loadGlobalConfig();
          const claudeMdPaths = [
            ...(_spawnCfg['provide-native-config-to-agents'] === true && mod.id === 'github-copilot'
              ? [path.join(os.homedir(), '.copilot', 'copilot-instructions.md')]
              : []),
            ...(_spawnCfg['provide-native-config-to-agents'] === true && (mod.id === 'gemini' || mod.id === 'gemini-vertex')
              ? [path.join(os.homedir(), '.gemini', 'GEMINI.md')]
              : []),
            path.join(HARNESS, 'CLAUDE.md'),
          ];
          const memoryMdPaths = _resolveMemoryMdPaths(rootDir);
          const contextFileName = (mod.id === 'gemini' || mod.id === 'gemini-vertex') ? 'GEMINI.md' : undefined;
          const agentsTeardown = agentsMdGenerator.setup({ rootDir, claudeMdPaths, memoryMdPaths, contextFileName });

          // §8: always suppress ~/.copilot/copilot-instructions.md for Copilot spawns.
          // When provide-native-config-to-agents is true, setup() already merged its content into AGENTS.md
          // above; suppressing prevents the provider from double-loading the native file.
          // When false, suppression enforces harness isolation (native file is blanked, restored on exit).
          const copilotInstructionsTeardown = mod.id === 'github-copilot'
            ? agentsMdGenerator.suppressCopilotInstructions()
            : null;

          // Same pattern for Gemini: always suppress ~/.gemini/GEMINI.md during Gemini spawns.
          const geminiInstructionsTeardown = (mod.id === 'gemini' || mod.id === 'gemini-vertex')
            ? agentsMdGenerator.suppressGeminiInstructions()
            : null;

          let stderrBuf = '';
          try {
            const { child, logDir, waitForExit, getStdout } = spawnFn.call(mod, { prompt: payload, model, cwd: rootDir, silent: !!silent });
            if (child.stderr) child.stderr.on('data', d => { stderrBuf += d.toString(); });
            const exitCode = await waitForExit();
            const stdoutBuf = getStdout ? getStdout() : '';
            const events = mod.parseStream(exitCode, logDir, stderrBuf, stdoutBuf);
            if (mod.cleanupLogDir) mod.cleanupLogDir(logDir);

            const textParts = [];
            let usageData = null;
            let errorMsg = null;
            for (const ev of events) {
              if (ev.type === 'assistant_text') textParts.push(ev.content.text);
              if (ev.type === 'usage') usageData = ev.content;
              if (ev.type === 'error' && !textParts.length) errorMsg = ev.content.message;
            }
            if (errorMsg && !textParts.length) {
              const quotaEvent = events.find(e => e.type === 'error' && e.content && e.content.code === 'error_quota');
              if (quotaEvent) {
                // Tag quota errors with structured flags so run-agent.js can route them
                // through the cross-provider fallback chain instead of dying. Without
                // these flags the harness would treat this as a generic spawn failure.
                const qErr = new Error(
                  `[${mod.id}] API quota exhausted — ${errorMsg}\n` +
                  `Quota has been reached. Wait for the quota window to reset, then re-run the same pipeline command to retry.`
                );
                qErr.tokensExhausted = true;
                qErr.providerId = mod.id;
                throw qErr;
              }
              // Surface model-unavailable as a typed error so run-agent.js can attempt
              // a provider-aware fallback rather than surfacing a cryptic exit-code error.
              const modelUnavailEvent = events.find(e => e.type === 'error' && e.content && e.content.code === 'error_model_unavailable');
              if (modelUnavailEvent) {
                const err = new Error(errorMsg);
                err.modelUnavailable = true;
                err.attemptedModel = (modelUnavailEvent.content && modelUnavailEvent.content.attemptedModel) || null;
                throw err;
              }
              throw new Error(errorMsg);
            }

            return {
              text: textParts.join('\n\n'),
              model: null,
              usage: usageData ? {
                input_tokens: usageData.input_tokens || 0,
                output_tokens: usageData.output_tokens || 0,
                cache_read_input_tokens: 0,
              } : null,
              costUsd: null,
              fallbackNote: fallbackNote || null,
              effortNote: effortNote || null,
            };
          } finally {
            agentsTeardown();
            if (copilotInstructionsTeardown) copilotInstructionsTeardown();
            if (geminiInstructionsTeardown) geminiInstructionsTeardown();
          }
        },
  };
}

// stub-fixture is a test-only provider registered alongside live providers so
// e2e tests can spawn `node src/run-agent.js` with HARNESS_PROVIDER_OVERRIDE=
// stub-fixture and receive canned JSONL replies from disk instead of hitting
// any real CLI. Registered here (not lazily) so the registry contract stays
// uniform — all providers resolve via the same KNOWN_PROVIDERS map.
const KNOWN_PROVIDERS = {
  'claude-code': () => new (require('./claude-code'))(),
  'github-copilot': () => _adaptModule(require('./github-copilot')),
  'gemini': () => _adaptModule(require('./gemini')),
  'gemini-vertex': () => _adaptModule(require('./gemini-vertex')),
  'stub-fixture': () => new (require('./stub-fixture'))(),
};

function _loadGlobalConfig() {
  try { return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')); } catch { return {}; }
}

/**
 * Returns a Provider instance for the given id (or the id from global-config.json `provider`
 * field when id is omitted). Defaults to `claude-code` when neither is set.
 *
 * @param {string} [id]
 * @returns {import('./Provider')}
 * @throws {Error} with loginInstructions() hint on unknown provider id
 */
function getProvider(id) {
  const cfg = _loadGlobalConfig();
  // HARNESS_PROVIDER_OVERRIDE env var lets the e2e test suite force a specific
  // provider (e.g. stub-fixture) without editing global-config.json — which is
  // protected by the harness CONFIG GUARD and cannot be mutated by an agent.
  // Explicit `id` arg still wins so per-call resolution (`getProvider('gemini')`)
  // remains authoritative when the caller already knows what it wants.
  // SECURITY: gate this override to NODE_ENV=test (or explicit
  // HARNESS_ALLOW_PROVIDER_OVERRIDE=1 escape hatch) so a stray env var in a
  // production-style run cannot silently swap the user's configured provider.
  const envOverride = process.env.HARNESS_PROVIDER_OVERRIDE;
  const overrideAllowed =
    process.env.NODE_ENV === 'test' ||
    process.env.HARNESS_ALLOW_PROVIDER_OVERRIDE === '1';
  const effectiveOverride = overrideAllowed ? envOverride : undefined;
  const resolvedId = id || effectiveOverride || cfg.provider || 'claude-code';
  const factory = KNOWN_PROVIDERS[resolvedId];
  if (!factory) {
    const known = Object.keys(KNOWN_PROVIDERS).join(', ');
    throw new Error(
      `Unknown provider "${resolvedId}". Known providers: ${known}.\n` +
      `Set "provider": "<id>" in global-config.json, or pass a valid id to getProvider().`
    );
  }
  return factory();
}

module.exports = { getProvider };
