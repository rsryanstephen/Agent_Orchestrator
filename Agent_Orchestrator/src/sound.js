'use strict';

// Lightweight chime helper shared by broker / run-agent. Kept dependency-free
// so the parent broker can use it without booting the full agent runtime.

const { spawn } = require('child_process');
const path = require('path');

// Module-level latch: suppress overlapping beeps.
let _beepInFlight = false;

// Resolve a `*-sound-file` value to an absolute `.wav` path. Bare filenames
// resolve under the Windows media dir (so `tada.wav` etc. work unqualified);
// absolute/other-relative paths pass through. Mirrors run-agent.js so a
// broker-side custom `.wav` resolves identically to the in-process one.
function _resolveWavPath(val) {
  if (path.isAbsolute(val)) return val;
  if (!/[\\/]/.test(val)) return path.join('C:\\Windows\\Media', val);
  return path.resolve(__dirname, '..', val);
}

// Play a `.wav` file via PowerShell `Media.SoundPlayer`. On spawn error clears
// the latch and stays silent (synthesized-beep fallback removed — every event
// sound is now a `.wav` file).
function _playWav(wavPath) {
  if (_beepInFlight) return;
  _beepInFlight = true;
  const wav = _resolveWavPath(wavPath).replace(/'/g, "''");
  const psCmd = `(New-Object Media.SoundPlayer '${wav}').PlaySync()`;
  const ps = spawn('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'ignore', detached: false, windowsHide: true });
  ps.on('exit', () => { _beepInFlight = false; });
  ps.on('error', () => { _beepInFlight = false; });
}

// Resolve a per-event sound: env override (the resolved `*-sound-file` value
// bridged by run-parallel.js) or the named `.wav` default, and play it as a
// `.wav` file. Non-Windows -> BEL.
function _playEvent(envName, defaultWav) {
  if (process.platform !== 'win32') { process.stdout.write('\x07'); return; }
  const val = String(process.env[envName] || defaultWav || '').trim();
  if (!val) return;
  _playWav(val);
}

// Event-specific wrappers exposed for the parallel broker (which runs in a
// separate process with no topic config in scope). Each plays the named system
// `.wav` default for the matching `*-sound-file` config key. Broker-side config
// override is bridged via `AMA_SOUND_*` env vars: `run-parallel.js` exports the
// resolved `*-sound-file` value into the environment before spawning the broker,
// so a user's custom `.wav` takes effect broker-side too. Defaults kept in
// lockstep with run-agent.js (in-process is authoritative).
//
// Clarifying tone is gated: `run-parallel.js` sets `AMA_SUPPRESS_CLARIFYING=1`
// when `auto-answer-clarifying-questions-and-submit` is on, since the harness
// then answers+submits without pausing, so the "your input is needed" tone
// would be spurious.
function playClarifyingSound() {
  if (process.env.AMA_SUPPRESS_CLARIFYING === '1') return;
  _playEvent('AMA_SOUND_CLARIFYING', 'Alarm01.wav');
}
function playQueueFetchSound() {
  _playEvent('AMA_SOUND_QUEUE_FETCH', 'notify.wav');
}
function playCompletionSound() {
  _playEvent('AMA_SOUND_COMPLETION', 'tada.wav');
}
function playTokenLimitSound() {
  _playEvent('AMA_SOUND_TOKEN_LIMIT', 'Windows Notify Messaging.wav');
}
function playErrorSound() {
  _playEvent('AMA_SOUND_ERROR', 'Windows Critical Stop.wav');
}

module.exports = {
  playClarifyingSound,
  playQueueFetchSound,
  playCompletionSound,
  playTokenLimitSound,
  playErrorSound,
};
