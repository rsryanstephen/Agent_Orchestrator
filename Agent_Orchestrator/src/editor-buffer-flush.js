'use strict';

// Editor-agnostic buffer-flush. Extracted from run-agent.js so non-pipeline
// entry points (`run-parallel.js`, `auto-resume.js`, memory/topic CLIs) can
// invoke the same flush as soon as the user types a harness command — this
// captures IDE/editor edits made just before the command was submitted.
//
// Reads `editor-save-all-command` (new) first, falls back to legacy
// `vscode-save-all-command`. Empty string -> opt out. See README + global-config.

const { spawnSync } = require('child_process');
const configUtils = require('./config-utils');

let _failureLogged = false;

// Set on first successful flush so child processes (spawned by run-parallel.js
// / auto-resume.js) can detect the buffers have already been flushed at the
// entry point and skip a redundant force-flush at dispatch entry. Avoids the
// double taskbar-flash assessment-2 flagged ("entry-point flush + child
// dispatch-entry force-flush -> two spawns per hrun invocation").
const FLUSHED_ENV = 'HARNESS_EDITOR_FLUSHED';

// Busy-free sleep via Atomics.wait on an unshared int — used to give the editor a
// moment to actually persist after the save-all command returns.
function sleepMs(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Main flush: resolves the configured save-all command (new key + legacy fallback),
// spawns it once with a Windows .cmd retry path, optionally sleeps, and sets the
// inheritable env flag so child processes don't redundantly flush again.
function flushEditorBuffers(topicConfig, config) {
  try {
    // Skip if an ancestor process already flushed this run — prevents
    // double-spawn (entry-point + child dispatch-entry) -> double taskbar flash.
    if (process.env[FLUSHED_ENV] === '1') return;
    // Lazy-load global config when caller doesn't have one (entry-point scripts).
    if (!config) {
      try { config = configUtils.loadConfig(configUtils.globalConfigPath()); }
      catch { config = {}; }
    }
    topicConfig = topicConfig || {};

    const DEFAULT_EDITOR_SAVE_CMD = 'code --reuse-window --command workbench.action.files.saveAll';
    const newVal = configUtils.cfgRead(topicConfig, config, 'editor-save-all-command', null);
    const legacyVal = configUtils.cfgRead(topicConfig, config, 'vscode-save-all-command', null);
    const resolved = newVal != null ? newVal : (legacyVal != null ? legacyVal : DEFAULT_EDITOR_SAVE_CMD);
    const cmd = String(resolved).trim();
    if (!cmd) return;

    const flushMs = Number(
      configUtils.cfgRead(topicConfig, config, 'editor-save-flush-ms', null)
      ?? configUtils.cfgRead(topicConfig, config, 'vscode-save-flush-ms', 200)
    ) || 0;

    const parts = cmd.match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
    const argv = parts.map(p => p.replace(/^["']|["']$/g, ''));
    if (argv.length === 0) return;
    const [bin, ...rest] = argv;

    let r = spawnSync(bin, rest, { shell: false, timeout: 3000, encoding: 'utf8', windowsHide: true });
    const isCodeLikeBin = process.platform === 'win32' && /^(code(-insiders)?|cursor)(\.cmd|\.bat|\.exe)?$/i.test(bin);
    if (r.error && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL') && isCodeLikeBin) {
      const retryBin = /\.(cmd|bat|exe)$/i.test(bin) ? bin : `${bin}.cmd`;
      r = spawnSync(retryBin, rest, { shell: true, timeout: 3000, encoding: 'utf8', windowsHide: true });
    }
    if ((r.status !== 0 || r.error) && !_failureLogged) {
      _failureLogged = true;
      const errDetail = (r.error && r.error.message) || (r.stderr && r.stderr.trim()) || `exit ${r.status}`;
      console.error(`editor-save-all-command unavailable ("${bin}": ${errDetail}) — continuing silently.`);
    }
    if (flushMs > 0) sleepMs(flushMs);
    // Mark flushed AFTER successful spawn so child processes inherit the flag
    // and skip their own dispatch-entry force-flush.
    process.env[FLUSHED_ENV] = '1';
  } catch (e) {
    if (!_failureLogged) {
      _failureLogged = true;
      console.error(`editor-save-all-command threw: ${e.message} — continuing silently.`);
    }
  }
}

module.exports = { flushEditorBuffers, saveAllVsCodeBuffers: flushEditorBuffers };
