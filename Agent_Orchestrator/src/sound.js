'use strict';

// Lightweight chime helper shared by broker / run-agent. Kept dependency-free
// so the parent broker can use it without booting the full agent runtime.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Module-level latches: suppress overlapping beeps + only warn once if the wav is missing.
let _beepInFlight = false;
let _missingWarned = false;

// Cross-platform chime: on Windows shell out to PowerShell SoundPlayer (sync play in a
// detached child so we don't block); on other platforms emit the terminal BEL char.
function playChime({ soundFile = 'C:\\Windows\\Media\\chimes.wav' } = {}) {
  if (_beepInFlight) return;
  try {
    if (process.platform === 'win32') {
      const resolved = path.isAbsolute(soundFile) ? soundFile : path.join(__dirname, '..', soundFile);
      if (!fs.existsSync(resolved)) {
        if (!_missingWarned) {
          _missingWarned = true;
          process.stderr.write(`[sound] notification-sound-file not found: ${resolved} — chime disabled.\n`);
        }
        return;
      }
      _beepInFlight = true;
      const safePath = resolved.replace(/'/g, "''");
      const psCmd = `(New-Object Media.SoundPlayer '${safePath}').PlaySync()`;
      const ps = spawn('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'ignore', detached: false, windowsHide: true });
      const clear = () => { _beepInFlight = false; };
      ps.on('exit', clear);
      ps.on('error', clear);
    } else {
      process.stdout.write('\x07');
    }
  } catch {
    _beepInFlight = false;
  }
}

module.exports = { playChime };
