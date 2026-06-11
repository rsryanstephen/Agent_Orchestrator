'use strict';

// Pure multi-line reply accumulator shared by `promptForUserReply` (run-agent.js)
// and the parallel broker (parallel-broker.js). No I/O — caller feeds line events.
//
// Submission rules (must stay in lock-step with promptForUserReply):
//   - `:submit` or `:s` on its own line submits immediately.
//   - Two consecutive blank lines submit, but only after at least one
//     non-blank line has been buffered (prevNonBlank guard).
//   - All other lines (including single blanks) are pushed to bufferLines.

// Factory: per-instance line buffer + submission-state machine.
// Returns { onLine, getBuffer, state, bufferLines } — caller drives line events.
function createReplyAccumulator() {
  const bufferLines = [];
  const state = { prevNonBlank: false, blankRun: 0, submitted: false };
  function onLine(line) {
    if (state.submitted) return true;
    const trimmed = (line == null ? '' : String(line)).trim();
    if (trimmed === ':submit' || trimmed === ':s') {
      state.submitted = true;
      return true;
    }
    if (trimmed === '') {
      state.blankRun++;
      if (state.blankRun >= 2 && state.prevNonBlank) {
        state.submitted = true;
        return true;
      }
      bufferLines.push(line);
    } else {
      bufferLines.push(line);
      state.prevNonBlank = true;
      state.blankRun = 0;
    }
    return false;
  }
  function getBuffer() {
    const out = bufferLines.slice();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n');
  }
  return { onLine, getBuffer, state, bufferLines };
}

module.exports = { createReplyAccumulator };
