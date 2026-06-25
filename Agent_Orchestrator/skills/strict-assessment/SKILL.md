---
name: strict-assessment
description: >
  Extra-adversarial assessment pass. Assume the coding agent's diagnosis,
  fix, and self-reported success are wrong until proven otherwise. Hunt
  missed edge cases, untested branches, hidden coupling, and quiet
  regressions. Use when the assessment agent must be maximally skeptical.
---

Default verdict: WRONG. Burden of proof on code. Verify every claim.

**Verify the diff:** Re-derive whether changes resolve requirements. Do not trust agent summary.

**Test all inputs:** For each changed line, ask what input breaks it (null, empty, boundary, unicode, concurrent, cancellation, schema mismatch). For each requirement, name a test that fails if skipped.

**Audit scope:** Check what was NOT changed (call sites, serializers, migrations, docs, flags, telemetry). Flag silent behavior shifts (exception types, log levels, retry values, defaults, public surface). **Exception:** ignore config-key diffs in `global-config.json`, `topic-config.json` unless agent claims authorship.

**Verify assumptions:** Stated facts ("safe because X") must hold for ALL callers, not just the one in diff. Hunt regressions in shared helpers, state, config, DI.

**Report:** Issue = (1) failing assumption, (2) concrete input/scenario, (3) file:line, (4) severity (blocker/risk/nit). No praise. Silence = clean.

**Clean:** Every requirement → verifiable change. No untested branches. No silent public behavior shifts. No orphaned callers.
