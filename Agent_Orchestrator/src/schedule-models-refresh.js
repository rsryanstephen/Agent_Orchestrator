#!/usr/bin/env node
/**
 Registers a weekly Windows Scheduled Task (`ClaudeHarnessModelsRefresh`) that runs
 `update-models-reference.js`. Idempotent — skips if the task is already registered.
 Mirrors the Register-ScheduledTask pattern used by scheduleSharedWake in run-agent.js.

 Usage:
   node Agent_Orchestrator/schedule-models-refresh.js          # register if missing
   node Agent_Orchestrator/schedule-models-refresh.js --force  # re-register (overwrite)

 Exports `ensureModelsRefreshScheduled()` so run-agent.js can lazily wire it on startup.
**/
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Constants: scheduled task name, script it runs, and the marker file we use as a
// cheap "already scheduled" cache so we don't re-shell PowerShell on every hrun.
const HARNESS = path.join(__dirname, '..');
const ROOT = path.join(HARNESS, '..');
const TASK_NAME = 'ClaudeHarnessModelsRefresh';
const SCRIPT_PATH = path.join(HARNESS, 'src', 'update-models-reference.js');
const MARKER = path.join(HARNESS, '.state', 'models-refresh-scheduled.json');

function log(msg) { console.log(`[schedule-models-refresh] ${msg}`); }

// Authoritative check via Get-ScheduledTask. Slow — only used to repair a missing marker.
function taskAlreadyRegistered() {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) -ne $null`,
  ], { encoding: 'utf8' });
  return r.status === 0 && /True/i.test((r.stdout || '').trim());
}

// Main entry: idempotent scheduler. Fast path = marker present. Slow path =
// verify with PowerShell, then either restore the marker or freshly Register-ScheduledTask
// for a weekly Sunday 03:00 run.
function ensureModelsRefreshScheduled({ force = false, verbose = false } = {}) {
  if (process.platform !== 'win32') {
    const NIX_NOTICE = path.join(HARNESS, '.state', 'models-refresh-unix-notice.json');
    if (!fs.existsSync(NIX_NOTICE)) {
      log(`Non-Windows platform — weekly auto-refresh not registered. Add a cron/at entry for \`node ${path.relative(ROOT, SCRIPT_PATH)}\` or run \`hupdate-models\` manually.`);
      try { fs.mkdirSync(path.dirname(NIX_NOTICE), { recursive: true }); fs.writeFileSync(NIX_NOTICE, JSON.stringify({ noticedAt: new Date().toISOString() }) + '\n', 'utf8'); } catch {}
    }
    return { ok: false, reason: 'non-windows' };
  }
  // Marker is the cheap path — trust it on every `hrun`. The full PS verification only runs
  // when the marker is missing (first run, manual deletion, or --force).
  if (!force && fs.existsSync(MARKER)) {
    if (verbose) log(`Marker present — task "${TASK_NAME}" assumed registered. Use --force to re-register.`);
    return { ok: true, reason: 'marker-present' };
  }
  if (!force && taskAlreadyRegistered()) {
    // Task exists but marker missing — rewrite marker to skip PS check next time.
    try { fs.mkdirSync(path.dirname(MARKER), { recursive: true }); fs.writeFileSync(MARKER, JSON.stringify({ rediscoveredAt: new Date().toISOString() }, null, 2) + '\n', 'utf8'); } catch {}
    if (verbose) log(`Task "${TASK_NAME}" already registered — marker restored.`);
    return { ok: true, reason: 'already-registered' };
  }
  // ---- Build first-run datetime + Register-ScheduledTask command ----
  // First Sunday from now at 03:00 local. PowerShell -DaysOfWeek Sunday handles recurrence.
  const now = new Date();
  const first = new Date(now);
  first.setHours(3, 0, 0, 0);
  const daysUntilSunday = (7 - first.getDay()) % 7 || 7;
  first.setDate(first.getDate() + daysUntilSunday);
  const pad = n => String(n).padStart(2, '0');
  const isoLocal = `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(first.getDate())}T${pad(first.getHours())}:${pad(first.getMinutes())}:00`;
  const psCmd =
    `$ErrorActionPreference='Stop';` +
    `$a=New-ScheduledTaskAction -Execute 'node' -Argument '"${SCRIPT_PATH.replace(/'/g, "''")}"' -WorkingDirectory '${ROOT.replace(/'/g, "''")}';` +
    `$t=New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At ([datetime]'${isoLocal}');` +
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Force | Out-Null`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { encoding: 'utf8' });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || 'unknown').trim();
    if (verbose) log(`Warning: failed to register task (${err}).`);
    return { ok: false, reason: err };
  }
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify({ registeredAt: new Date().toISOString(), firstRun: isoLocal }, null, 2) + '\n', 'utf8');
  } catch {}
  log(`Weekly task "${TASK_NAME}" registered — first run ${isoLocal}, then every Sunday.`);
  return { ok: true, reason: 'registered' };
}

module.exports = { ensureModelsRefreshScheduled };

// CLI entry: forward --force flag, exit non-zero on failure.
if (require.main === module) {
  const force = process.argv.includes('--force');
  const res = ensureModelsRefreshScheduled({ force, verbose: true });
  process.exit(res.ok ? 0 : 1);
}
