'use strict';

// Generates a temporary AGENTS.md at repo root from CLAUDE.md + MEMORY.md before
// a Copilot spawn, then restores the original on exit. Copilot auto-loads AGENTS.md
// from the repo root (it also checks .github/copilot-instructions.md but this path
// is authoritative for the harness).

const fs = require('fs');
const os = require('os');
const path = require('path');

const BAK_SUFFIX = '.harness-bak';

let _registered = false;
const _teardownCallbacks = [];

function _runTeardowns() {
  for (const cb of _teardownCallbacks) {
    try { cb(); } catch {}
  }
}

function _ensureSignalHandlers() {
  if (_registered) return;
  _registered = true;
  process.on('exit', _runTeardowns);
  process.on('SIGINT', () => { _runTeardowns(); process.exit(130); });
  process.on('uncaughtException', (err) => {
    _runTeardowns();
    console.error('[agents-md-generator] uncaughtException — teardown ran:', err && err.message);
    process.exit(1);
  });
}

/**
 * Build AGENTS.md content from available source files.
 * Falls back gracefully when files are absent.
 */
function buildAgentsMdContent(claudeMdPaths, memoryMdPaths) {
  const sections = [];

  for (const p of claudeMdPaths) {
    if (!p) continue;
    const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
    if (!fs.existsSync(resolved)) continue;
    try {
      const text = fs.readFileSync(resolved, 'utf8').trim();
      if (text) sections.push(text);
    } catch {}
  }

  for (const p of memoryMdPaths) {
    if (!p) continue;
    const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
    if (!fs.existsSync(resolved)) continue;
    try {
      // Resolve inline [[name]] references to sibling files in same directory.
      const dir = path.dirname(resolved);
      let text = fs.readFileSync(resolved, 'utf8').trim();
      text = text.replace(/\[\[([^\]]+)\]\]/g, (_, name) => {
        const linked = path.join(dir, `${name}.md`);
        if (fs.existsSync(linked)) {
          try { return fs.readFileSync(linked, 'utf8').trim(); } catch {}
        }
        return '';
      });
      if (text) sections.push(text);
    } catch {}
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Generate AGENTS.md in rootDir before a Copilot spawn.
 * Backs up any existing AGENTS.md as AGENTS.md.harness-bak.
 *
 * opts.rootDir      - repo root where AGENTS.md is written (required)
 * opts.claudeMdPaths - array of CLAUDE.md paths to concat (global then project)
 * opts.memoryMdPaths - array of MEMORY.md paths to concat
 *
 * Returns teardown function (also registered on process.exit / SIGINT / uncaughtException).
 */
function setup(opts) {
  const { rootDir, claudeMdPaths = [], memoryMdPaths = [], contextFileName = 'AGENTS.md' } = opts || {};
  if (!rootDir) throw new Error('agents-md-generator.setup: rootDir is required');

  _ensureSignalHandlers();

  const agentsMdPath = path.join(rootDir, contextFileName);
  const bakPath = agentsMdPath + BAK_SUFFIX;

  // Back up existing context file (never clobber user's file without backup).
  let hadExisting = false;
  if (fs.existsSync(agentsMdPath)) {
    try {
      fs.copyFileSync(agentsMdPath, bakPath);
      hadExisting = true;
    } catch (e) {
      throw new Error(`agents-md-generator: could not back up AGENTS.md: ${e.message}`);
    }
  }

  const content = buildAgentsMdContent(claudeMdPaths, memoryMdPaths);
  if (content) {
    fs.writeFileSync(agentsMdPath, content + '\n', 'utf8');
  } else if (hadExisting) {
    // Nothing to write; keep the backup in place but don't stomp with empty file.
    // Teardown will still restore.
  }

  const teardown = () => {
    try {
      if (hadExisting && fs.existsSync(bakPath)) {
        fs.copyFileSync(bakPath, agentsMdPath);
        try { fs.unlinkSync(bakPath); } catch {}
      } else if (!hadExisting && fs.existsSync(agentsMdPath)) {
        try { fs.unlinkSync(agentsMdPath); } catch {}
        try { fs.unlinkSync(bakPath); } catch {}
      }
    } catch {}
  };

  _teardownCallbacks.push(teardown);
  return teardown;
}

/**
 * Manually trigger teardown for rootDir (removes harness-generated context file,
 * restores backup). Idempotent.
 * contextFileName defaults to 'AGENTS.md' to match setup() default.
 */
function teardown(rootDir, contextFileName = 'AGENTS.md') {
  if (!rootDir) return;
  const agentsMdPath = path.join(rootDir, contextFileName);
  const bakPath = agentsMdPath + BAK_SUFFIX;
  try {
    if (fs.existsSync(bakPath)) {
      fs.copyFileSync(bakPath, agentsMdPath);
      fs.unlinkSync(bakPath);
    } else if (fs.existsSync(agentsMdPath)) {
      fs.unlinkSync(agentsMdPath);
    }
  } catch {}
}

// Back up and blank a single file; return a teardown fn.
// Does NOT push to _teardownCallbacks — the outer caller manages registration.
function _suppressSingleFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return () => {};
  const bakPath = filePath + BAK_SUFFIX;
  try {
    fs.copyFileSync(filePath, bakPath);
    fs.writeFileSync(filePath, '', 'utf8');
  } catch (e) {
    throw new Error(`agents-md-generator: could not suppress ${filePath}: ${e.message}`);
  }
  return () => {
    try {
      if (fs.existsSync(bakPath)) {
        fs.copyFileSync(bakPath, filePath);
        try { fs.unlinkSync(bakPath); } catch {}
      }
    } catch {}
  };
}

// Resolve VS Code global User config directory (cross-platform).
function _resolveVSCodeGlobalUserDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User');
}

/**
 * Backs up and blanks two Copilot double-injection sources before a harness spawn:
 *   1. ~/.copilot/copilot-instructions.md  (standalone Copilot CLI global instructions)
 *   2. <VSCode-User>/AGENTS.md             (VS Code Copilot agent-mode global context)
 * Both files are restored on teardown.
 *
 * opts.filePath       — override path (1) (used in tests)
 * opts.vscodeFilePath — override path (2); pass null to skip VS Code suppression (used in tests)
 * Returns combined teardown function (also registered on process exit / SIGINT / uncaughtException).
 */
function suppressCopilotInstructions(opts) {
  const filePath = (opts && opts.filePath)
    ? opts.filePath
    : path.join(os.homedir(), '.copilot', 'copilot-instructions.md');

  // VS Code global AGENTS.md is a second double-injection vector for Copilot agent mode.
  // opts.vscodeFilePath: override for tests; pass null to skip; undefined = auto-resolve.
  const vscodeAgentsMdPath = (opts && 'vscodeFilePath' in opts)
    ? opts.vscodeFilePath
    : path.join(_resolveVSCodeGlobalUserDir(), 'AGENTS.md');

  _ensureSignalHandlers();

  const t1 = _suppressSingleFile(filePath);
  const t2 = vscodeAgentsMdPath ? _suppressSingleFile(vscodeAgentsMdPath) : () => {};

  const combined = () => { t1(); t2(); };
  _teardownCallbacks.push(combined);
  return combined;
}

// Backs up and blanks ~/.gemini/GEMINI.md before a Gemini harness spawn so the
// global Gemini CLI instructions do not double-inject on top of the harness-generated GEMINI.md.
// File is restored on teardown. opts.filePath overrides the target path (used in tests).
function suppressGeminiInstructions(opts) {
  const filePath = (opts && opts.filePath)
    ? opts.filePath
    : path.join(os.homedir(), '.gemini', 'GEMINI.md');

  _ensureSignalHandlers();

  const t1 = _suppressSingleFile(filePath);
  _teardownCallbacks.push(t1);
  return t1;
}

// Backs up and blanks ~/.claude/CLAUDE.md before a harness spawn so the global
// Claude instructions do not double-inject on top of harness-injected skills content.
// File is restored on teardown. opts.filePath overrides the target path (used in tests).
function suppressClaudeInstructions(opts) {
  const filePath = (opts && opts.filePath)
    ? opts.filePath
    : path.join(os.homedir(), '.claude', 'CLAUDE.md');

  _ensureSignalHandlers();

  const t1 = _suppressSingleFile(filePath);
  _teardownCallbacks.push(t1);
  return t1;
}

module.exports = { setup, teardown, buildAgentsMdContent, suppressCopilotInstructions, suppressGeminiInstructions, suppressClaudeInstructions };
