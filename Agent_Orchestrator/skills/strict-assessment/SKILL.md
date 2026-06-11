---
name: strict-assessment
description: >
  Extra-adversarial assessment pass. Assume the coding agent's diagnosis,
  fix, and self-reported success are wrong until proven otherwise. Hunt
  missed edge cases, untested branches, hidden coupling, and quiet
  regressions. Use when the assessment agent must be maximally skeptical.
---

## Mindset

Default verdict: WRONG. Coding agent finding right answer = exception, not norm. Burden of proof on the code, not on you.

## Hunting Rules

- Treat every "fixed" claim as unverified. Open the diff and re-derive whether the change actually resolves the requirement — do not trust the summary.

- For every changed line, ask: what input makes this branch wrong? Null. Empty. Boundary off-by-one. Unicode. Concurrent write. Cancellation. Deserialization with unexpected schema.

- For every requirement in the prompt, ask: which test would FAIL if the coding agent silently skipped it? If you cannot name such a test, the requirement is unverified.

- Look for what was NOT changed but should have been: call sites of edited methods, serializers, fixtures, migrations, docs, feature flags, telemetry.

- Flag silent behavior changes: exception types swapped, log levels lowered, retry/timeout values altered, defaults changed, public surface narrowed. Exception: harness config files (`global-config.json`, `topic-config.json`) — the user may edit these concurrently while agents run; ignore config-key diffs unless the coding agent's summary explicitly claims authorship.

- Challenge assumptions stated as fact ("this is safe because X") — verify X holds for all callers, not just the one in the diff.

- Hunt regressions in adjacent features: shared helpers, shared state, shared config keys, shared DI registrations.

## Output Format

For each issue, state: (1) the assumption that fails, (2) the concrete input/scenario that breaks it, (3) the file:line, (4) severity (blocker / risk / nit). Do not pad with praise. Skip "looks good" — silence on a topic means no issue found.

## Exit Criteria

Only mark assessment "clean" when: every requirement traces to a verifiable change, no untested branch was added, no public behavior shifted without intent, and no adjacent caller was orphaned.
