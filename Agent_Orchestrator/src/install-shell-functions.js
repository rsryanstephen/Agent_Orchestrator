#!/usr/bin/env node
// Installs the harness shell functions from shell-functions.txt into the user's
// ~/.bashrc and ~/.zshrc (whichever exist, or .bashrc by default on Windows).
// Idempotent: if a function name from the source file is already defined in the
// target rc file, no changes are made. Re-run with --force to reinstall the block.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Sentinel markers wrapping the managed block inside ~/.bashrc / ~/.zshrc — used to
// detect and re-write our section without disturbing user-authored shell code.
const BEGIN = '# >>> Agent_Orchestrator shell functions >>>';
const END = '# <<< Agent_Orchestrator shell functions <<<';

function log(msg)  { console.log(`[install-shell-functions] ${msg}`); }
function ok(msg)   { console.log(`[install-shell-functions] OK: ${msg}`); }
function warn(msg) { console.warn(`[install-shell-functions] WARN: ${msg}`); }
function fail(msg) { console.error(`[install-shell-functions] ERROR: ${msg}`); }

const SOURCE = path.join(__dirname, '..', 'shell-functions.txt');

// Functions use relative paths — they must be run from the repo root where
// Agent_Orchestrator/ was placed. No substitution needed; pass through as-is.
function renderSource(raw) {
  return raw;
}

// Programmatic install entry (CLI re-implements this below to support exit codes).
// Detects existing managed block / conflicting unmanaged definitions, then writes
// or refreshes the block in each target rc file (.bashrc, .zshrc).
function install({ force = false } = {}) {
  if (!fs.existsSync(SOURCE)) {
    return { ok: false, reason: `Source file not found: ${SOURCE}`, installedCount: 0, skippedCount: 0, failedCount: 1 };
  }
  const sourceContent = renderSource(fs.readFileSync(SOURCE, 'utf8'));
  const fnNames = Array.from(sourceContent.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)/gm)).map(m => m[1]);
  const LEGACY_FNS = ['runp','runc','runa','runf','runaf','runpc','runcaf','runall','runcont','runpar','hstartt','hsett','hrentopic','hrmtopic','hrun','hresume','hclear','hcompress','hqregen','hupdate-models','hprobe'];
  if (fnNames.length === 0) {
    return { ok: false, reason: `No function definitions found in ${SOURCE}`, installedCount: 0, skippedCount: 0, failedCount: 1 };
  }
  const home = os.homedir();
  const candidates = [
    { shell: 'bash', file: path.join(home, '.bashrc') },
    { shell: 'zsh',  file: path.join(home, '.zshrc')  },
  ];
  const existing = candidates.filter(c => fs.existsSync(c.file));
  const targets = existing.length > 0 ? existing : [candidates[0]];
  if (existing.length === 0) log(`No existing rc file found — will create ${targets[0].file}`);

  let installedCount = 0, skippedCount = 0, failedCount = 0;
  for (const { shell, file } of targets) {
    try {
      let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const hasBlock = content.includes(BEGIN) && content.includes(END);
      const outsideBlock = hasBlock
        ? content.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), '')
        : content;
      const allKnown = [...fnNames, ...LEGACY_FNS];
      const conflicts = allKnown.filter(name => new RegExp(`^\\s*${name}\\s*\\(\\)`, 'm').test(outsideBlock));

      if (!force && hasBlock) {
        ok(`${shell}: managed block already present in ${file} — no changes`);
        skippedCount++;
        continue;
      }
      if (!force && conflicts.length > 0) {
        ok(`${shell}: ${conflicts.length} harness function(s) already defined in ${file} (${conflicts.join(', ')}) — no changes. Re-run with --force to remove the unmanaged definitions and install the managed block.`);
        skippedCount++;
        continue;
      }

      const block = `${BEGIN}\n# Managed by Agent_Orchestrator/install-shell-functions.js — do not edit by hand.\n# Re-run with --force to refresh this block.\n${sourceContent.trimEnd()}\n${END}\n`;
      let next;
      if (hasBlock && force) {
        next = content.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`), block);
      } else {
        if (force && conflicts.length > 0) {
          for (const name of conflicts) {
            content = content.replace(new RegExp(`^[ \\t]*${name}\\s*\\(\\)\\s*\\{[^}]*\\}[ \\t]*\\n?`, 'gm'), '');
          }
          warn(`${shell}: removed ${conflicts.length} unmanaged function definition(s) (${conflicts.join(', ')}) from ${file} before installing managed block.`);
        }
        const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
        next = `${content}${sep}\n${block}`;
      }

      try {
        fs.writeFileSync(file, next, 'utf8');
      } catch (e) {
        if (e.code === 'EACCES' || e.code === 'EPERM') {
          fail(`${shell}: permission denied writing ${file}. Re-run from an elevated shell.`);
          failedCount++;
          continue;
        }
        throw e;
      }
      ok(`${shell}: ${hasBlock ? 'refreshed' : 'installed'} ${fnNames.length} function(s) in ${file}`);
      installedCount++;
    } catch (e) {
      fail(`${shell}: ${e.message}`);
      failedCount++;
    }
  }

  console.log('');
  log(`Summary — installed: ${installedCount}, skipped: ${skippedCount}, failed: ${failedCount}`);
  if (installedCount > 0) {
    log(`Open a new shell, or run "source ~/.bashrc" / "source ~/.zshrc" to load the functions.`);
    log(`Functions use relative paths — run them from the repo root where Agent_Orchestrator/ was placed.`);
  }
  return { ok: failedCount === 0, installedCount, skippedCount, failedCount };
}

module.exports = { install };

if (require.main !== module) {
  // Required as a module — do not run the CLI body below.
  return;
}

// ---- CLI body (only runs when invoked directly) ----
// Parses --force, discovers rc files, then mirrors install() but emits process.exit.
const FORCE = process.argv.includes('--force');
const sourceContent = renderSource(fs.readFileSync(SOURCE, 'utf8'));

// Extract function names like `foo()    {` from the source.
const fnNames = Array.from(sourceContent.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)/gm)).map(m => m[1]);
// Legacy function names from previous harness versions — stripped on --force install so users
// don't end up with both the old runX / runpar and the new hrun definitions in their rc file.
const LEGACY_FNS = ['runp','runc','runa','runf','runaf','runpc','runcaf','runall','runcont','runpar','hstartt','hsett','hrentopic','hrmtopic','hrun','hresume','hclear','hcompress','hqregen','hupdate-models','hprobe'];
if (fnNames.length === 0) {
  fail(`No function definitions found in ${SOURCE}`);
  process.exit(1);
}

const home = os.homedir();
const candidates = [
  { shell: 'bash', file: path.join(home, '.bashrc') },
  { shell: 'zsh',  file: path.join(home, '.zshrc')  },
];

// If neither file exists, create .bashrc (most common on Git Bash for Windows).
const existing = candidates.filter(c => fs.existsSync(c.file));
const targets = existing.length > 0 ? existing : [candidates[0]];
if (existing.length === 0) {
  log(`No existing rc file found — will create ${targets[0].file}`);
}

let installedCount = 0;
let skippedCount = 0;
let failedCount = 0;

// Per-target rc-file processing: detect existing managed block / conflicts, then
// either skip, refresh in place, or strip conflicts + append a fresh block.
for (const { shell, file } of targets) {
  try {
    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

    // Check if our managed block is already present.
    const hasBlock = content.includes(BEGIN) && content.includes(END);

    // Check if any of our function names are already defined outside our block.
    const outsideBlock = hasBlock
      ? content.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), '')
      : content;
    const allKnown = [...fnNames, ...LEGACY_FNS];
    const conflicts = allKnown.filter(name => new RegExp(`^\\s*${name}\\s*\\(\\)`, 'm').test(outsideBlock));

    if (!FORCE && hasBlock) {
      ok(`${shell}: managed block already present in ${file} — no changes`);
      skippedCount++;
      continue;
    }
    if (!FORCE && conflicts.length > 0) {
      ok(`${shell}: ${conflicts.length} harness function(s) already defined in ${file} (${conflicts.join(', ')}) — no changes. Re-run with --force to remove the unmanaged definitions and install the managed block.`);
      skippedCount++;
      continue;
    }

    const block = `${BEGIN}\n# Managed by Agent_Orchestrator/install-shell-functions.js — do not edit by hand.\n# Re-run with --force to refresh this block.\n${sourceContent.trimEnd()}\n${END}\n`;

    let next;
    if (hasBlock && FORCE) {
      next = content.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`), block);
    } else {
      // --force with unmanaged conflicts: strip each conflicting function definition line before appending.
      if (FORCE && conflicts.length > 0) {
        for (const name of conflicts) {
          // Remove the function definition line (and its trailing `}` on the same or next line).
          content = content.replace(new RegExp(`^[ \\t]*${name}\\s*\\(\\)\\s*\\{[^}]*\\}[ \\t]*\\n?`, 'gm'), '');
        }
        if (conflicts.length > 0) {
          warn(`${shell}: removed ${conflicts.length} unmanaged function definition(s) (${conflicts.join(', ')}) from ${file} before installing managed block.`);
        }
      }
      const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
      next = `${content}${sep}\n${block}`;
    }

    try {
      fs.writeFileSync(file, next, 'utf8');
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        fail(`${shell}: permission denied writing ${file}. Re-run this command from an elevated shell (Run as Administrator on Windows, or use sudo on macOS/Linux).`);
        failedCount++;
        continue;
      }
      throw e;
    }
    ok(`${shell}: ${hasBlock ? 'refreshed' : 'installed'} ${fnNames.length} function(s) in ${file}`);
    installedCount++;
  } catch (e) {
    fail(`${shell}: ${e.message}`);
    failedCount++;
  }
}

console.log('');
log(`Summary — installed: ${installedCount}, skipped: ${skippedCount}, failed: ${failedCount}`);
if (installedCount > 0) {
  log(`Open a new shell, or run "source ~/.bashrc" / "source ~/.zshrc" to load the functions.`);
  log(`Functions use relative paths — run them from the repo root where Agent_Orchestrator/ was placed.`);
}
process.exit(failedCount > 0 ? 1 : 0);

// Regex-escape helper for embedding the BEGIN/END markers and function names in
// dynamically-built RegExp patterns.
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
