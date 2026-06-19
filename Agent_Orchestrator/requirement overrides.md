# Requirement Overrides

Pairs of durable harness-behaviour requirements where a **later** user prompt contradicted and overrode an **earlier** one. Per the audit rule, the later requirement always wins. Ordering is by document position in the topic history (`topic_files/claude_harness/claude_harness.md` + dated `backups/*.md`); newer = later. Each entry records the earlier (overridden) requirement, the later (winning) requirement, and the source.

---

- **Notification sound — playback trigger.**

  - Earlier (overridden): a single `playNotificationSound` chime fired after **every** agent phase via the per-phase `post` hook (`run-agent.js:2135`).

  - Later (wins): play a sound on **only five** events (user-response-needed, queue-fetch, completion+session-end, token-limit wait, error-stop); no chime on any other occasion.

  - Source: live history "User Prompt" at `claude_harness.md:527`.

---

- **Notification sound — sound assets per event.**

  - Earlier (overridden): the five events use distinct **stock Windows `.wav`** files, with dequeue defaulting to `Windows Notify System Generic.wav`.

  - Later (wins): no event may use the generic stock tone; each must be a unique sound (first swapped to other distinct `.wav` files, e.g. dequeue → `Windows Proximity Notification.wav`, completion → `tada.wav`).

  - Source: live history "User Prompt" at `claude_harness.md:1281`.

---

- **Notification sound — playback mechanism (final state).**

  - Earlier (overridden): chimes play `.wav` files through `New-Object Media.SoundPlayer ... .PlaySync()`.

  - Later (wins): "complete change of approach" — replace `.wav` playback with **synthesized `[console]::beep(freq,dur)` multi-note sequences** for all five events, each unmistakably distinct (separated by `Start-Sleep` so adjacent same-freq pulses do not fuse); `*-sound-file` keys reinterpreted as optional `freq:dur,...` specs.

  - Source: live history "User Prompt" + auto-reply at `claude_harness.md:1447`–`1481`.

---

- **Config key name `provide-user-config`.**

  - Earlier (overridden): the native-config gate key is named `provide-user-config`.

  - Later (wins): rename the key to `provide-native-config-to-agents` across all source + tests (semantics and default-`false` behaviour unchanged).

  - Source: live history "User Prompt" at `claude_harness.md:1086`.

---

- **Current-turn agent-response context handling.**

  - Earlier (overridden): inject agent-response bodies truncated to `CONTEXT_TRUNCATION` chars (config key `context-truncation`).

  - Later (wins): delete `CONTEXT_TRUNCATION` + the slice + the config read entirely, and wire the `history-self-lookup` skill into the five main roles instead (lazy on-demand history lookup; parallel fan-out paths intentionally excluded).

  - Source: live history "User Prompt" at `claude_harness.md:867` (instruction 2 + approved skill).

---

- **Latest Opus model id.**

  - Earlier (overridden): `LATEST_OPUS = 'claude-opus-4-7'`.

  - Later (wins): `LATEST_OPUS = 'claude-opus-4-8'` (aligned with `models-reference.md`); `resolveModelId('opus')`/`'Opus'` resolves to `claude-opus-4-8`.

  - Source: live history remediation at `claude_harness.md:850`–`861`.

---

- **Shell-function path model + installer note.**

  - Earlier (overridden): README/installer claim the installer "embeds the absolute path of that copy" so the `h*` functions "work from any cwd", and the note tells users to re-run the installer with `--force` after moving the harness.

  - Later (wins): functions use **relative paths** and must be **run from the repo root** where the harness was placed; replace the note with "Run the installed shell functions from the repo root where the harness has been placed."

  - Source: live history "User Prompt" at `claude_harness.md:1563`.

---

- **Claude Code as a prerequisite.**

  - Earlier (overridden): README installation section lists Claude Code CLI as a hard requirement.

  - Later (wins): Claude Code is **preferred but not mandatory**; other providers under `src/lib/providers/` are supported.

  - Source: live history "User Prompt" at `claude_harness.md:1563`.

---

- **Inlined-skills defaults — caveman.**

  - Earlier (overridden): `SKILLS_INLINE_DEFAULTS` included `'caveman'`, so `buildInlinedSkillsClause` inlined the caveman body for providers lacking a native skillsRuntime.

  - Later (wins): remove `caveman` from `SKILLS_INLINE_DEFAULTS` and filter it out in `buildInlinedSkillsClause`, because `buildSystemPrompt` already injects `cavemanClause` unconditionally — inlining too double-injects and wastes tokens.

  - Source: live history remediation at `claude_harness.md:1263`–`1269`.

---

## Additional override pairs sourced from archived backups

Cross-date contradictions found by re-running Phase 1 over the archived snapshots. Source file for all entries below is `topic_files/claude_harness/backups/claude_harness.archive-2026-06-12T17-00-07.md` (the cumulative superset of historical prompts; `.md.bak` files skipped per the audit rule).

---

- **Native user-config gating mechanism.**

  - Earlier (overridden): three per-provider flags `suppress-copilot-global-instructions`, `suppress-gemini-global-instructions`, `suppress-claude-global-instructions` controlled whether each provider's native config (`~/.copilot/copilot-instructions.md`, `~/.gemini/GEMINI.md`, `~/.claude/CLAUDE.md`) was blanked to avoid double-injected skills.

  - Later (wins): remove all three `suppress-*-global-instructions` flags; replace their function with a single `provide-user-config` key that, when true, injects the provider-applicable native config into the system prompt (later itself renamed `provide-native-config-to-agents` in live history).

  - Source: backup `:1867`/`:1961` (flags introduced) → `:2169` (flags removed, replaced).

---

- **`provide-user-config` semantics direction.**

  - Earlier (overridden): `provide-user-config === true` SUPPRESSED the native user config and a harness CLAUDE.md prepend supplied instructions instead (default false meant native config loaded).

  - Later (wins): invert — `false` SUPPRESSES the native config so `~/.claude/CLAUDE.md` does not load at all, `true` lets it load with no harness prepend; drop the harness CLAUDE.md prepend and the legacy `suppress-claude-global-instructions` branch.

  - Source: backup `:2056` (added) → `:3103` ("Chat - changes to undo.md").

---

- **Karpathy clause double-inject guard.**

  - Earlier (overridden): add a `_karpathyWouldDoubleInject()` / `_userClaudeMdHasKarpathy` guard so the harness `# Karpathy Guidelines` clause is skipped when the native `~/.claude/CLAUDE.md` already carries it.

  - Later (wins): undo the guard — delete `_karpathyWouldDoubleInject`/`_userClaudeMdHasKarpathy`; the karpathy clause appends unconditionally.

  - Source: backup `:2807` (guard added) → `:3103` (guard reverted).

---

- **Per-provider model-tier selection.**

  - Earlier (overridden): static hardcoded `PROVIDER_AUTO_MODELS` tier constants chose the auto model per provider.

  - Later (wins): dynamic per-provider catalog lookup (`model-catalog.js`, `.model-catalog-cache.json`, 30-day TTL + refresh command) selects the latest available model; static constants demoted to a fallback floor only.

  - Source: backup `:1256` (static tiers) → `:1671`/`:1693` (dynamic catalog).

---

- **Queue-header token parsing strictness.**

  - Earlier (overridden): strict all-or-nothing — every header token had to classify or the whole first line fell through into the prompt body; `pro`/`flash`/`fable` matched as bare family words.

  - Later (wins): lenient — treat the first line as the header if it contains ANY recognized keyword, discard unclassifiable tokens with a warn-log (never leak header into body), and remove `pro`/`flash`/`fable` from the bare-word family list (match only paired with a model/provider token or as an exact model id).

  - Source: backup `:2429`/`:2717` (strict) → `:3362` ("prompt headers still not working.md").

---

- **History auto-compression.**

  - Earlier (overridden): auto-compress feature with `max-history-lines` config + `history-archive-compress-on-archive` injected `## Compressed Memory` summaries on the queue and archive-rollover paths.

  - Later (wins): remove all auto-compress functionality and the `max-history-lines` key entirely; no `## Compressed Memory` injection anywhere; add a one-shot scrub stripping lingering compressed-memory sections from every topic history.

  - Source: backup `:3525` ("Plnning agent rejected.md").

---

- **Auto-resume execution mode.**

  - Earlier (overridden): config-selectable detached-vs-inline auto-resume (`use-detached-auto-resume` flag + legacy `auto-resume-mode` key + `scheduleSharedWake`/`Register-ScheduledTask` OS-wake plumbing).

  - Later (wins): collapse to inline-only — remove `use-detached-auto-resume`, the legacy `auto-resume-mode` key, and the scheduled-task plumbing; show an inline countdown and auto-resume in-process.

  - Source: backup `:3972` (item 3 restores inline; item 4 removes detached).

---

- **Token-exhaustion surfacing.**

  - Earlier (overridden): hitting the token/context limit surfaced a generic `Phase N (X) failed: Claude exited with code 1`.

  - Later (wins): show a dedicated message that the token limit was reached (e.g. `Token limit reached for model <X>; consider switching model or clearing memory`) via `TokenLimitError`/`classifyContextLimitError`.

  - Source: backup `:3640`.

---

- **Auto-submit flag implication.**

  - Earlier (overridden): auto-submitting clarifying answers required BOTH `auto-answer-clarifying-questions` AND `auto-answer-clarifying-questions-and-submit` to be true.

  - Later (wins): `auto-answer-clarifying-questions-and-submit: true` alone implies `auto-answer-clarifying-questions: true` (submit flag is sufficient).

  - Source: backup `:533`.

---

- **Default dequeue notification tone.**

  - Earlier (overridden): dequeue tone defaulted to a stock `.wav` (`Windows Notify System Generic.wav`, then `chimes.wav`).

  - Later (wins): change the default dequeue tone to `Windows Notify Calendar.wav` (itself later superseded by the synthesized `[console]::beep` approach — see the live-history sound entries above, which win as the final state).

  - Source: backup `:1479` → `:3236`.
