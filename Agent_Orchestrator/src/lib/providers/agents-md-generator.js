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

module.exports = { setup, teardown, buildAgentsMdContent };
