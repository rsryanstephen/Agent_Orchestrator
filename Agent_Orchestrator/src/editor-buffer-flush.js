'use strict';

// Editor-agnostic buffer-flush. Extracted from run-agent.js so non-pipeline
// entry points (`run-parallel.js`, `auto-resume.js`, memory/topic CLIs) can
// invoke the same flush as soon as the user types a harness command — this
// captures IDE/editor edits made just before the command was submitted.
//
// Mechanism: keystroke flush only (no config knobs). All tunables are hardcoded
// non-configurable constants below. The Save-All chord is auto-detected from the
// running IDE's keybindings.json (VS Code / Cursor / VSCodium) so the user's own
// "Save All" binding applies to the harness; falls back to VS Code's default
// Ctrl+K S (`^(k)s`) when no override is found.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let _failureLogged = false;

// Set on first successful flush so child processes (spawned by run-parallel.js
// / auto-resume.js) can detect the buffers have already been flushed at the
// entry point and skip a redundant force-flush at dispatch entry. Avoids the
// double taskbar-flash ("entry-point flush + child dispatch-entry flush -> two
// spawns per hrun invocation").
const FLUSHED_ENV = 'HARNESS_EDITOR_FLUSHED';

// ── Hardcoded, non-configurable defaults ──────────────────────────────────────
// Previously read from `editor-save-flush-ms` / `editor-save-flush-timeout-ms` /
// `editor-window-match` / `editor-save-all-keys`. Made constants so flush timing
// and window matching can no longer be tuned (or silently broken) via config.
const FLUSH_MS = 200;                // settle delay after sending the chord
const KEYSTROKE_TIMEOUT = 8000;      // PowerShell spawn timeout (cold .NET Add-Type)
const WIN_MATCH = /code|cursor|codium|devenv|sublime_text|idea64|rider64/; // editor proc names
const SAVE_ALL_FALLBACK = '^(k)s';   // VS Code Save-All (Ctrl+K then S)

// Per-IDE-family default Save-All chord (SendKeys form). Only VS Code-family
// editors expose a parseable keybindings.json; non-family editors (Visual Studio /
// JetBrains / Sublime) have no such file, so without this map they fell back to the
// VS Code chord `^(k)s` — wrong for them, so the harness would focus the editor and
// send a no-op chord (buffers NOT saved). Mapping each family to its native default
// Save-All chord keeps "save before submit" working for every matched IDE.
//   devenv  (Visual Studio)        -> Ctrl+Shift+S  = ^+(s)
//   idea64/rider64 (JetBrains)     -> Ctrl+S        = ^(s)
//   sublime_text (Sublime)         -> Ctrl+S        = ^(s)  (no native Save-All; best effort)
const FAMILY_FALLBACK_CHORDS = {
  devenv: '^+(s)',
  idea64: '^(s)',
  rider64: '^(s)',
  sublime_text: '^(s)'
};

// Busy-free sleep via Atomics.wait on an unshared int — used to give the editor a
// moment to actually persist after the save-all chord is sent.
function sleepMs(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Convert a single VS Code key segment (e.g. `ctrl+k`, `ctrl+shift+s`, `s`) into
// its .NET SendKeys form. Modifiers map ctrl->^, shift->+, alt->% (cmd/meta/win
// have no Windows SendKeys equivalent and are dropped). A modified key is wrapped
// in parentheses (`^(k)`) so the modifier scopes to exactly that key.
const SENDKEYS_SPECIAL = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
  space: ' ', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  delete: '{DEL}', del: '{DEL}', backspace: '{BACKSPACE}', insert: '{INSERT}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}'
};
const MODIFIERS = {
  ctrl: '^', control: '^', shift: '+', alt: '%', option: '%'
};
function _convertSegment(segment) {
  const tokens = segment.split('+').map(t => t.trim().toLowerCase()).filter(Boolean);
  let prefix = '';
  let keyTok = '';
  for (const tok of tokens) {
    if (Object.prototype.hasOwnProperty.call(MODIFIERS, tok)) prefix += MODIFIERS[tok];
    else if (tok === 'cmd' || tok === 'command' || tok === 'meta' || tok === 'win' || tok === 'super') {
      /* no Windows SendKeys equivalent — drop */
    } else keyTok = tok;
  }
  if (!keyTok) return '';
  let keyOut = Object.prototype.hasOwnProperty.call(SENDKEYS_SPECIAL, keyTok)
    ? SENDKEYS_SPECIAL[keyTok]
    : keyTok;
  // Escape a bare SendKeys metacharacter used as the literal key.
  if (keyOut.length === 1 && /[+^%~(){}\[\]]/.test(keyOut)) keyOut = `{${keyOut}}`;
  return prefix ? `${prefix}(${keyOut})` : keyOut;
}

// Convert a full VS Code chord (space-separated segments, e.g. `ctrl+k s`) to a
// SendKeys string. Returns '' when nothing converts so callers fall back.
function convertChordToSendKeys(vscodeChord) {
  if (!vscodeChord || typeof vscodeChord !== 'string') return '';
  const segments = vscodeChord.trim().split(/\s+/).filter(Boolean);
  return segments.map(_convertSegment).join('');
}

// Parse a keybindings.json (JSONC: tolerate // and /* */ comments + trailing
// commas) and return the `key` of the LAST positive binding for
// `workbench.action.files.saveAll` (later entries override earlier ones in VS
// Code). Negative bindings (`-workbench.action.files.saveAll`) are ignored.
// Returns null on parse failure or no override.
function parseKeybindingsForSaveAll(jsoncText) {
  try {
    const stripped = String(jsoncText)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    const arr = JSON.parse(stripped);
    if (!Array.isArray(arr)) return null;
    let found = null;
    for (const entry of arr) {
      if (entry && entry.command === 'workbench.action.files.saveAll' && typeof entry.key === 'string') {
        found = entry.key;
      }
    }
    return found;
  } catch {
    return null;
  }
}

// Find the first running editor process whose name matches WIN_MATCH; returns the
// lowercase process name (or null). Windows-only — one PowerShell probe.
function _detectEditorProcName() {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-Process|Where-Object{$_.MainWindowHandle -ne 0 -and $_.ProcessName -match '${WIN_MATCH.source}'}|Select-Object -First 1 -ExpandProperty ProcessName; if($p){Write-Output $p}`],
      { shell: false, timeout: KEYSTROKE_TIMEOUT, encoding: 'utf8', windowsHide: true });
    if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) {
      return r.stdout.trim().toLowerCase();
    }
  } catch { /* fall through to null */ }
  return null;
}

// Map a VS Code-family process name to its user keybindings.json path. Non-family
// editors (devenv / sublime / idea64 / rider64) have no keybindings.json in this
// format, so they return null -> fallback chord.
function _keybindingsPathFor(procName) {
  const appData = process.env.APPDATA;
  if (!appData || !procName) return null;
  const n = procName.toLowerCase();
  let dir = null;
  if (n === 'code') dir = 'Code';
  else if (n === 'cursor') dir = 'Cursor';
  else if (n === 'codium' || n === 'vscodium') dir = 'VSCodium';
  if (!dir) return null;
  return path.join(appData, dir, 'User', 'keybindings.json');
}

// Pick the default Save-All chord for a detected process: a non-VS-Code family
// editor uses its native chord from FAMILY_FALLBACK_CHORDS; everything else
// (VS Code family, unknown, or no IDE detected) uses the VS Code default `^(k)s`.
function _fallbackChordFor(procName) {
  const n = (procName || '').toLowerCase();
  return FAMILY_FALLBACK_CHORDS[n] || SAVE_ALL_FALLBACK;
}

// Resolve the Save-All SendKeys chord: detect running IDE -> if it is a VS Code
// family editor, read its keybindings.json and convert its
// `workbench.action.files.saveAll` binding; otherwise use the IDE family's native
// default chord. Any failure (missing file, parse error, no override) falls back to
// the detected family's default chord (VS Code `^(k)s` when none applies), so
// non-VS-Code IDEs are saved with the correct chord instead of a wrong no-op.
// `opts` is an injection seam for tests (procName / keybindingsPath / readFile) so
// no PowerShell spawn is needed.
function resolveSaveAllChord(opts) {
  opts = opts || {};
  try {
    const procName = opts.procName !== undefined ? opts.procName : _detectEditorProcName();
    const fallback = _fallbackChordFor(procName);
    const kbPath = opts.keybindingsPath !== undefined ? opts.keybindingsPath : _keybindingsPathFor(procName);
    if (!kbPath) return fallback;
    const readFile = opts.readFile || (p => fs.readFileSync(p, 'utf8'));
    let text;
    try { text = readFile(kbPath); } catch { return fallback; }
    const vscodeChord = parseKeybindingsForSaveAll(text);
    if (!vscodeChord) return fallback;
    const chord = convertChordToSendKeys(vscodeChord);
    return chord || fallback;
  } catch {
    return SAVE_ALL_FALLBACK;
  }
}

// Keystroke-based flush (the sole flush mechanism). Focus the running editor's
// window and synthesize its Save-All chord via Win32 + WinForms SendKeys. The
// chord is auto-detected from the IDE's keybindings.json. Windows-only — non-win32
// is a no-op (the harness's supported platform is Windows).
function flushViaKeystroke() {
  if (process.platform !== 'win32') return;
  try {
    const keys = resolveSaveAllChord();
    if (!keys) return;

    // Escape single quotes for safe embedding in the single-quoted PowerShell
    // literals below.
    const reLit = WIN_MATCH.source.replace(/'/g, "''");
    const keyLit = keys.replace(/'/g, "''");

    // Focus the first matching editor window (restore if minimized) then send the
    // Save-All chord. Exit 2 when no matching window is open so the caller can
    // warn once instead of sending keys to the wrong (focused) app.
    const script = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$re='${reLit}'; $keys='${keyLit}';`,
      'Add-Type @"',
      'using System;using System.Runtime.InteropServices;',
      'public class Hx{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);',
      '[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);}',
      '"@;',
      '$p=Get-Process|Where-Object{$_.MainWindowHandle -ne 0 -and $_.ProcessName -match $re}|Select-Object -First 1;',
      'if(-not $p){exit 2};',
      '[Hx]::ShowWindow($p.MainWindowHandle,9)|Out-Null;',
      '[Hx]::SetForegroundWindow($p.MainWindowHandle)|Out-Null;',
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Start-Sleep -Milliseconds 120;',
      '[System.Windows.Forms.SendKeys]::SendWait($keys);'
    ].join('');

    const r = spawnSync('powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { shell: false, timeout: KEYSTROKE_TIMEOUT, encoding: 'utf8', windowsHide: true });

    // status 2 = no matching editor window found (deliberate exit); surface once.
    if ((r.status === 2 || r.error) && !_failureLogged) {
      _failureLogged = true;
      const detail = r.status === 2
        ? `no window matched /${WIN_MATCH.source}/ — open your editor`
        : (r.error && r.error.message) || `exit ${r.status}`;
      console.error(`editor keystroke-flush skipped (${detail}) — continuing silently.`);
    }
    sleepMs(FLUSH_MS);
  } catch (e) {
    if (!_failureLogged) {
      _failureLogged = true;
      console.error(`editor keystroke-flush threw: ${e.message} — continuing silently.`);
    }
  }
}

// Main flush: delegates to the keystroke flush (sole mechanism), then sets the
// inheritable env flag so child processes don't redundantly flush again. No
// config is read — flush behaviour is fully hardcoded.
function flushEditorBuffers() {
  try {
    // Skip if an ancestor process already flushed this run — prevents double
    // spawn (entry-point + child dispatch-entry) -> double taskbar flash.
    if (process.env[FLUSHED_ENV] === '1') return;
    flushViaKeystroke();
    process.env[FLUSHED_ENV] = '1';
  } catch (e) {
    if (!_failureLogged) {
      _failureLogged = true;
      console.error(`editor buffer flush failed: ${e.message} — continuing silently.`);
    }
  }
}

// Export FLUSHED_ENV so the in-process `run-agent.js` copy can honour the same
// cross-process guard (single source of truth for the env-var name). The
// chord/keybindings helpers are exported for unit tests.
module.exports = {
  flushEditorBuffers,
  saveAllVsCodeBuffers: flushEditorBuffers,
  flushViaKeystroke,
  resolveSaveAllChord,
  convertChordToSendKeys,
  parseKeybindingsForSaveAll,
  FLUSHED_ENV
};
