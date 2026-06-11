'use strict';

// Resolves the `use-claude-advisor-tool` config into per-role booleans, gated
// by provider. The advisor tool is a Claude-Code-only feature; for any other
// provider the flags are forced off and a one-time INFO is emitted.

// Per-provider warn-once memo so unsupported-provider notices don't spam.
const _warned = new Set();

// Normalise raw config (bool | per-role obj) -> {planning, coding, assessment}.
// Returns all-false for non-claude-code providers.
function getAdvisorFlags(cfg, providerId, logFn) {
  const raw = cfg['use-claude-advisor-tool'];
  const none = { planning: false, coding: false, assessment: false };
  if (!raw) return none;
  const flags = (typeof raw === 'object' && raw !== null)
    ? { planning: !!raw.planning, coding: !!raw.coding, assessment: !!raw.assessment }
    : { planning: !!raw, coding: !!raw, assessment: !!raw };
  if (providerId !== 'claude-code') {
    if ((flags.planning || flags.coding || flags.assessment) && !_warned.has(providerId)) {
      _warned.add(providerId);
      if (logFn) logFn('[INFO] use-claude-advisor-tool is only available for provider "claude-code"; ignoring for provider "' + providerId + '".');
    }
    return none;
  }
  return flags;
}

// Test hook — clears the warn-once memo between runs.
function resetAdvisorWarned() { _warned.clear(); }

module.exports = { getAdvisorFlags, resetAdvisorWarned };
