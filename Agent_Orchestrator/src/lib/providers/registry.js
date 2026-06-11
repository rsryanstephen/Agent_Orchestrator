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
          if (typeof mod.probe === 'function') {
            const ok = mod.probe();
            if (!ok) {
              const hint = typeof mod.loginInstructions === 'function' ? mod.loginInstructions() : '';
              throw new Error(
                `Provider "${mod.id}" failed pre-spawn probe — check auth/environment.\n` +
                (hint ? hint + '\n' : '')
              );
            }
          }

          // §2: inject skills inline for providers without native skillsRuntime.
          if (typeof mod.injectSkillsInline === 'function') {
            payload = mod.injectSkillsInline(payload);
          }

          // §7: generate AGENTS.md from CLAUDE.md + MEMORY.md before copilot spawn.
          const agentsMdGenerator = require('./agents-md-generator');
          const claudeMdPaths = [
            path.join(os.homedir(), '.claude', 'CLAUDE.md'),
            path.join(HARNESS, 'CLAUDE.md'),
          ];
          const memoryMdPaths = _resolveMemoryMdPaths(rootDir);
          const contextFileName = (mod.id === 'gemini' || mod.id === 'gemini-vertex') ? 'GEMINI.md' : undefined;
          const agentsTeardown = agentsMdGenerator.setup({ rootDir, claudeMdPaths, memoryMdPaths, contextFileName });

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
                throw new Error(
                  `[${mod.id}] API quota exhausted — ${errorMsg}\n` +
                  `Quota has been reached. Wait for the quota window to reset, then re-run the same pipeline command to retry.`
                );
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
          }
        },
  };
}

const KNOWN_PROVIDERS = {
  'claude-code': () => new (require('./claude-code'))(),
  'github-copilot': () => _adaptModule(require('./github-copilot')),
  'gemini': () => _adaptModule(require('./gemini')),
  'gemini-vertex': () => _adaptModule(require('./gemini-vertex')),
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
  const resolvedId = id || cfg.provider || 'claude-code';
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
