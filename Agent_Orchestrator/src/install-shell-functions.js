#!/usr/bin/env node
// Installs the harness shell functions from shell-functions.txt into the user's
// ~/.bashrc and ~/.zshrc (whichever exist, or .bashrc by default on Windows).
// Idempotent: if a function name from the source file is already defined in the
// target rc file, no changes are made. Re-run with --force to reinstall the block.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, writeConfig, globalConfigPath } = require('./config-utils');

// Sentinel markers wrapping the managed block inside ~/.bashrc / ~/.zshrc — used to
// detect and re-write our section without disturbing user-authored shell code.
const BEGIN = '# >>> Agent_Orchestrator shell functions >>>';
const END = '# <<< Agent_Orchestrator shell functions <<<';
const STUB_HINT = 'Please run the install script using';

function log(msg)  { console.log(`[install-shell-functions] ${msg}`); }
function ok(msg)   { console.log(`[install-shell-functions] OK: ${msg}`); }
function warn(msg) { console.warn(`[install-shell-functions] WARN: ${msg}`); }
function fail(msg) { console.error(`[install-shell-functions] ERROR: ${msg}`); }

const SOURCE = path.join(__dirname, '..', 'shell-functions.txt');

// Resolve the absolute harness root substituted into shell-functions.txt.
// Prefers the `harness-root` global-config key; falls back to the inner
// Agent_Orchestrator dir derived from this script's location. Normalizes
// Windows backslashes -> forward slashes (bash-safe) and strips trailing slash.
// Expand a leading `~` / `~/` to the user's home dir. `path.join` and
// `fs.existsSync` treat `~` as a literal segment, so a config value like
// "~/Repos/.../Agent_Orchestrator" would fail the src/ existence check and
// trigger a false "no src/ subdir" warning. Expand before any fs use.
function expandTilde(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveHarnessRoot() {
  let root = '';
  try {
    const cfg = loadConfig(globalConfigPath());
    // Expand `~` so a tilde-prefixed harness-root resolves to a real path.
    if (cfg && typeof cfg['harness-root'] === 'string') root = expandTilde(cfg['harness-root'].trim());
  } catch (e) { /* missing/unreadable config -> fall back to self-detect */ }
  if (!root) root = path.join(__dirname, '..');
  // Sanity-check the resolved root actually points at a harness dir (must contain
  // src/). A wrong-but-nonempty config path would otherwise render into every h*
  // fn silently broken; warn + fall back to self-detect instead of trusting garbage.
  if (!fs.existsSync(path.join(root, 'src'))) {
    warn(`harness-root "${root}" has no src/ subdir — falling back to self-detected path. Fix "harness-root" in global-config.json.`);
    root = path.join(__dirname, '..');
  }
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

// Persist the resolved (auto-detected/expanded) harness root back into
// global-config.json so the user ends up with an explicit absolute `harness-root`
// after install — satisfies the requirement that installing also records the
// auto-detected route. Only writes when the stored value is missing or differs
// from the resolved root (avoids needless rewrites), and is best-effort: a write
// failure logs a warning but never aborts the install. writeConfig round-trips
// the existing `// harness-root` inline comment.
function persistHarnessRoot(root) {
  if (!root) return;
  let cfgPath;
  try {
    cfgPath = globalConfigPath();
    const cfg = loadConfig(cfgPath);
    const current = (cfg && typeof cfg['harness-root'] === 'string') ? cfg['harness-root'].trim() : '';
    const currentNorm = current.replace(/\\/g, '/').replace(/\/+$/, '');
    if (currentNorm === root) return; // already recorded — no rewrite needed
    cfg['harness-root'] = root;
    writeConfig(cfgPath, cfg);
    ok(`recorded auto-detected harness-root "${root}" in ${cfgPath}`);
  } catch (e) {
    warn(`could not record harness-root in global-config.json: ${e.message}`);
  }
}

// Substitute the {{HARNESS_ROOT}} placeholder so installed rc functions use
// absolute paths and work from any repo. Guards against an empty resolved root
// when the placeholder is actually present in the source. Also persists the
// resolved root back to global-config.json so subsequent runs have an explicit
// absolute path.
function renderSource(raw) {
  if (!raw.includes('{{HARNESS_ROOT}}')) return raw;
  const root = resolveHarnessRoot();
  if (!root) {
    throw new Error('Cannot substitute {{HARNESS_ROOT}}: set "harness-root" in global-config.json to the absolute path of the Agent_Orchestrator inner directory.');
  }
  persistHarnessRoot(root);
  return raw.replace(/\{\{HARNESS_ROOT\}\}/g, root);
}

function stripStubBlock(content, allKnown) {
  if (!content.includes(STUB_HINT)) return { content, removed: false, count: 0 };

  let next = content;
  let removed = false;
  let count = 0;
  const helperPattern = /^[ \t]*_harness_install_needed\s*\(\)\s*\{[\s\S]*?^[ \t]*\}[ \t]*\n?/m;
  if (helperPattern.test(next)) {
    next = next.replace(helperPattern, '');
    removed = true;
  }

  for (const name of allKnown) {
    const pattern = new RegExp(`^[ \\t]*${name}\\s*\\(\\)\\s*\\{[^}]*_harness_install_needed[^}]*\\}[ \\t]*\\n?`, 'gm');
    const matches = next.match(pattern);
    if (matches) {
      next = next.replace(pattern, '');
      removed = true;
      count += matches.length;
    }
  }

  next = next.replace(/^# If these stubs don't run, harness shell functions have not been installed yet\.\n?/m, '');
  next = next.replace(/^# Harness install .*\n(?:# .*\n)*/m, match => match.includes('{{harness_root}}') ? '' : match);
  next = next.replace(/\n{3,}/g, '\n\n');

  return { content: next, removed, count };
}

function managedBlockHasStubs(content) {
  if (!content.includes(BEGIN) || !content.includes(END)) return false;
  const match = content.match(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`));
  return Boolean(match && match[0].includes(STUB_HINT));
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
  const LEGACY_FNS = ['runp','runc','runa','runf','runaf','runpc','runcaf','runall','runcont','runpar','hstartt','hsett','hrentopic','hrmtopic','hrun','hresume','hclear','hcompress','hqregen','hupdate-models','hprobe','hcopy'];
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
      const blockHasStubs = managedBlockHasStubs(content);
      let outsideBlock = hasBlock
        ? content.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), '')
        : content;
      const allKnown = [...fnNames, ...LEGACY_FNS];
      const stubInfo = hasBlock ? { removed: false, count: 0 } : stripStubBlock(content, allKnown);
      if (!hasBlock && stubInfo.removed) {
        content = stubInfo.content;
        outsideBlock = content;
      }
      const conflicts = allKnown.filter(name => new RegExp(`^\\s*${name}\\s*\\(\\)`, 'm').test(outsideBlock));

      if (!force && hasBlock && !blockHasStubs) {
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
      if (hasBlock && (force || blockHasStubs)) {
        next = content.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`), block);
      } else {
        if (!hasBlock && stubInfo.removed) {
          warn(`${shell}: removed ${stubInfo.count} harness stub function(s) from ${file} before installing managed block.`);
        }
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
    log(`Functions use absolute paths — run them from any repo.`);
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
const LEGACY_FNS = ['runp','runc','runa','runf','runaf','runpc','runcaf','runall','runcont','runpar','hstartt','hsett','hrentopic','hrmtopic','hrun','hresume','hclear','hcompress','hqregen','hupdate-models','hprobe','hcopy'];
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
    const blockHasStubs = managedBlockHasStubs(content);

    // Check if any of our function names are already defined outside our block.
    let outsideBlock = hasBlock
      ? content.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), '')
      : content;
    const allKnown = [...fnNames, ...LEGACY_FNS];
    const stubInfo = hasBlock ? { removed: false, count: 0 } : stripStubBlock(content, allKnown);
    if (!hasBlock && stubInfo.removed) {
      content = stubInfo.content;
      outsideBlock = content;
    }
    const conflicts = allKnown.filter(name => new RegExp(`^\\s*${name}\\s*\\(\\)`, 'm').test(outsideBlock));

    if (!FORCE && hasBlock && !blockHasStubs) {
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
    if (hasBlock && (FORCE || blockHasStubs)) {
      next = content.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`), block);
    } else {
      if (!hasBlock && stubInfo.removed) {
        warn(`${shell}: removed ${stubInfo.count} harness stub function(s) from ${file} before installing managed block.`);
      }
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
  log(`Functions use absolute paths — run them from any repo.`);
}
process.exit(failedCount > 0 ? 1 : 0);

// Regex-escape helper for embedding the BEGIN/END markers and function names in
// dynamically-built RegExp patterns.
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
