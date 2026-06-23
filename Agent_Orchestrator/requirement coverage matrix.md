# Requirement Coverage Matrix

Master traceability list for the requirement-coverage audit. Every durable harness-behaviour requirement stated in any prompt was extracted by re-running Phase 1 over the full archive (`topic_files/claude_harness/backups/claude_harness.archive-2026-06-12T17-00-07.md` — the cumulative superset of all historical prompts; `.md.bak` snapshots skipped per the audit rule) plus the live `claude_harness.md` tail.

Each row records the requirement, its source location (`source-file:line` of the `## User Prompt` header), the run date, and the covering regression test (or `OVERRIDDEN` when a later prompt superseded it — see `requirement overrides.md`). One-off operational/content tasks (renames, release notes, one-time sounds) are excluded per the agreed scope.

Source-file legend:

- `A` = `topic_files/claude_harness/backups/claude_harness.archive-2026-06-12T17-00-07.md`
- `L` = `topic_files/claude_harness/claude_harness.md` (live)

All dates fall in the `2026-06-09` → `2026-06-12` window of the topic history.

| req-id | requirement | source | covering test |
|--------|-------------|--------|---------------|
| R01 | `use-claude-advisor-tool` config (default false; claude-code-only; auto-reset+warn off-provider) | A:141, A:2636 | `advisor-tool-config.test.js` |
| R02 | Reset `models`/`model-effort` to `auto` after each run; preserve `_harness_auto_set` | A:233, A:1600 | `auto-model-restore.test.js` |
| R03 | Auto-select model native to provider (copilot→gpt, claude-code→sonnet, gemini→pro) | A:283, A:1290 | `provider-integration.test.js`, `model-catalog-availability.test.js` |
| R04 | Implement copilot-gap-report workarounds; inject conditionally only for `github-copilot` | A:335 | `github-copilot-provider.test.js`, `provider-integration.test.js`, `copilot-smoke.test.js` |
| R05 | OUTPUT FORMATTING mandate on all roles, placed after caveman; validator exempt | A:451 | `agent-output-formatting-mandate.test.js` |
| R06 | `auto-answer-clarifying-questions-and-submit: true` implies auto-answer | A:533 | `auto-answer-clarifying-questions-stop-reason.test.js` |
| R07 | `enableStopReasonFallback` config (default false); graceful stop-reason handling | A:581 | `stop-reason-fallback.test.js` |
| R08 | Transient-error retry (429/529/overloaded) with exponential backoff + jitter | A:581 | `token-error-classifier.test.js`, `network-resume.test.js` |
| R09 | Repo-agnostic shell functions, run from harness repo root | A:667 | `install-shell-functions.test.js` |
| R10 | Five-hour session limit: countdown when reset time parseable, banner otherwise | A:737 | `token-error-classifier.test.js`, `auto-resume.test.js` |
| R11 | Implement gemini-gap-report workarounds; inject conditionally only for `gemini`/`gemini-vertex` | A:769 | `gemini-provider.test.js`, `gemini-smoke.test.js`, `gemini-vertex-provider.test.js` |
| R12 | Concept-level comments above code sections under `src` | A:803, A:929 | n/a (comment convention — not behaviourally testable) |
| R13 | Per-role `system-prompt-additions` topic-config key, appended after clauses | A:929 | `build-system-prompt.test.js` |
| R14 | Provider-agnostic copilot — no hardcoded `gpt-4o`; valid model ids per tier | A:1256 | `provider-integration.test.js` (PI14), `github-copilot-provider.test.js` |
| R15 | Auto-generate `## User Reply to Clarifying Questions` divider and append to history | A:1336 | `user-reply-extraction.test.js`, `auto-answer-clarifying-questions-formatting.test.js` |
| R16 | Model-unavailable detection → fall back to working model before burning retries | A:1391 | `model-unavailable-error.test.js`, `claude-code-model-fallback.test.js` |
| R17 | Sound on pipeline finish, interruption, and error-stop | A:1479 | `heartbeat-and-sound.test.js`, `notification-config.test.js` |
| R18 | Distinct innocuous tone on queue-fetch (dequeue) | A:1479 | `notification-config.test.js` |
| R19 | Dynamic per-provider model catalog + 30-day cache + refresh command + CLI validation | A:1671, A:1693 | `model-catalog-availability.test.js`, `model-preflight-fallback.test.js` |
| R20 | Caveman applies when `use-caveman: true`; no double-inject from external CLAUDE.md | A:1808 | `caveman-skill-no-double-inject.test.js`, `build-system-prompt.test.js` |
| R21 | `use-karpathy` configurable + neutralisation clause for external CLAUDE.md | A:1830 | `build-system-prompt.test.js` |
| R22 | Inline skills injected for copilot/gemini, gated by config flags | A:1867 | `provider-integration.test.js`, `github-copilot-provider.test.js`, `gemini-provider.test.js` |
| R23 | `provide-native-config-to-agents` gates injection of provider-native config | A:2056, L | `harness-improvements.test.js` |
| R24 | Pre-flight live availability check of configured model; fall back to `auto` (provider-aware) | A:2242 | `model-preflight-fallback.test.js` |
| R25 | Claude `/v1/models` catalog fetch must not 401 / spam fallback warning | A:2333 | `claude-models-auth-header.test.js` |
| R26 | Per-prompt provider/model via queue header (family keyword, exact spec, provider inference, `(hold)`) | A:2429 | `prompt-queue-header-tokens.test.js`, `prompt-queue-pipeline-spec.test.js` |
| R27 | **Cross-provider token-exhaustion fallback** (detect exhaustion → walk `fallback-providers` chain) | A:2518 | **`provider-token-exhausted-fallback.test.js`** (NEW — was a gap) |
| R28 | Header parser: provider-only tokens + family+version folding; header not injected as body | A:2717 | `prompt-queue-header-tokens.test.js`, `clarifying-header-injection.test.js` |
| R29 | Regression-test overhaul: e2e + provider-matrix + broker public-surface + failing-first + stub-fixture; no source-grep in new tests | A:2982 | `e2e-harness-prompt-to-history.test.js`, `provider-integration.test.js`, `parallel-broker-public-surface.test.js`, `regression-rule-failing-first.test.js`, `regression-test-policy.test.js` |
| R30 | Lenient header parsing (first line if any keyword); remove `pro`/`flash`/`fable` bare words | A:3362 | `prompt-queue-header-tokens.test.js`, `prompt-queue-hold-variants.test.js` |
| R31 | Reset `plannedSubtasks` each planning round (no stale compressed-memory sourcing) | A:3466 | `planning-subtasks-reset.test.js` |
| R32 | Remove auto-compress + `max-history-lines`; no `## Compressed Memory` injection; one-shot scrub | A:3525 | `no-compressed-memory-injection.test.js` |
| R33 | Dedicated token-limit message instead of generic exit-code error | A:3640 | `token-limit-error-message.test.js` |
| R34 | Atomic `.last-topic` write + corruption recovery | A:3640 | `last-topic-atomic-write.test.js`, `last-topic-corruption-recovery.test.js` |
| R35 | Stale `.last-topic` pointer auto-reset + test isolation (no real `.last-topic` writes in tests) | A:3805 | `last-topic-stale-pointer-recovery.test.js` |
| R36 | Inline countdown + in-process auto-resume on session/token limit | A:3972 | `inline-resume-signalfired-regression.test.js`, `auto-resume.test.js` |
| R37 | Remove `use-detached-auto-resume` + legacy `auto-resume-mode` + scheduled-task plumbing | A:3972 | `scheduled-tasks.test.js` (ST1a, ST10, ST15) |
| R38 | `editor-save-flush-timeout-ms` configurable (default 3000, floor 500) | L | `editor-save-flush-timeout-configurable.test.js` |
| R39 | Broker `AMA_SOUND_*` env bridge runs pre-broker; freq:dur-only guard | L | `broker-sound-override-env-bridge.test.js` |
| R40 | `history-self-lookup` skill wired into the five main roles | L | `history-self-lookup-wired.test.js` |
| R41 | History archive uses HTML markers, not frontmatter; archive fallback | L | `history-archive-marker-not-frontmatter.test.js`, `history-archive-fallback.test.js` |
| R42 | Planning citation verification | L | `planning-citation-verification.test.js` |

## Overridden requirements (no standalone test — superseded)

These were stated then contradicted by a later prompt; the later requirement wins and is the one tested (see `requirement overrides.md`). The earlier form is intentionally NOT covered.

| earlier requirement | source | superseded by |
|---------------------|--------|---------------|
| `suppress-*-global-instructions` flags | A:1867, A:1961 | `provide-native-config-to-agents` (R23) |
| `provide-user-config` true-suppresses semantics | A:2056 | inverted semantics (R23) |
| Karpathy double-inject guard | A:2807 | unconditional karpathy clause (R21) |
| Static `PROVIDER_AUTO_MODELS` tiers | A:1256 | dynamic catalog (R19) |
| Strict all-or-nothing header parsing | A:2429, A:2717 | lenient parsing (R30) |
| Auto-compress + `max-history-lines` | (pre-A) | removal (R32) |
| Detached auto-resume mode | A:3972 | inline-only (R37) |
| Generic exit-code token error | (pre-A) | dedicated message (R33) |
| `.wav`-file notification chimes | L | `[console]::beep` sequences (live sound entries) |

## Notes

- R12 (concept comments under `src`) is a documentation convention enforced by topic-config, not an observable runtime behaviour, so it has no behavioural regression test by design.
- R27 was the only genuine coverage gap found in the backup archive that was not already covered — a behavioural test was added against the requireable `classifyTokensExhausted` detection seam (run-agent's `_tryProviderFallback` chain is a CLI-internal closure and not separately requireable).
- All other backup-sourced requirements were already covered by the pre-existing 94-file suite; this audit added traceability, not redundant tests, per the "leave existing passing coverage as-is, only add for gaps" instruction.
