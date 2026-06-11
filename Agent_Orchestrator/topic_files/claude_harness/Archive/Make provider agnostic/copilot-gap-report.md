# GitHub Copilot Provider — Harness Feature Gap Report

> **Important:** `parseCopilotLogEntry()` field mappings in `src/lib/providers/github-copilot.js:8-12` are marked **[NEEDS-VERIFICATION]** against real CLI output. All field names (`entry.text`, `entry.quota_exceeded`, ratelimit header paths, etc.) are planning-agent assumptions about the standalone `copilot` CLI (public preview, post knowledge-cutoff). Quota/usage/ratelimit detection is unproven. Probe `copilot --help` and inspect a sample `--log-dir` run before trusting these mappings. The gap list below may grow once the CLI is probed.

---

## 1. Plan Mode — Two-Pass Gate

**Feature:** Read-only planning pass enforced via `--permission-mode plan` before the coding pass executes file writes.

**Claude Code mechanism:** `run-agent.js` resolves `--permission-mode plan` flag and passes it to the Claude CLI on the first pass. Only after plan approval does the coding pass run with full permissions. Controlled by `capabilities.planMode = true` (`claude-code.js:64`).

**Copilot behaviour:** `capabilities.planMode = false` (`github-copilot.js:96`). `spawnCopilot()` (`github-copilot.js:152`) only supports `--allow-all-tools` — no permission-mode flag is passed or supported.

**Downstream harness impact:** `src/run-agent.js` — the `plan-code` and `all` pipeline commands cannot enforce a read-only planning pass. The planning agent runs with full tool access, eliminating the two-pass safety gate.

**Workaround:** Compose the planning prompt to instruct the model to emit a plan only (no file edits), then manually review before triggering the coding phase. No CLI-level enforcement possible.

---

## 2. Skills Runtime — Native Skill Loading

**Feature:** Harness skills (`/caveman`, `/interrogate`, `/strict-assessment`) are auto-loaded by the Claude Code runtime from `skills/` directories during spawn.

**Claude Code mechanism:** `capabilities.skillsRuntime = true` (`claude-code.js:65`). The Claude CLI resolves skill definitions from `CLAUDE.md` and adjacent `skills/` dirs at startup via the `Skill` tool infrastructure.

**Copilot behaviour:** `capabilities.skillsRuntime = false` (`github-copilot.js:97`). `spawnCopilot()` accepts only `-p` (prompt), `--model`, `--mcp-config`, `--allow-all-tools`, `--log-dir`. No skill-directory injection path exists.

**Downstream harness impact:** Skills defined under `Agent_Orchestrator/skills/caveman/`, `skills/interrogate/`, `skills/strict-assessment/` are silently ignored. Interrogation gating (`## Clarifying Questions` header pause), caveman compression, and strict-assessment scoring all fail silently.

**Workaround:** Inline skill content (`SKILL.md` body) verbatim into the prompt payload before spawn. Increases token cost per call; no interactive skill invocation during a run.

---

## 3. Sub-Agents and Parallel Broker

**Feature:** Harness spawns multiple parallel Claude agents via `parallel-broker.js` / `run-parallel.js`, coordinated by `lib/fan-out.js`. Each sub-agent uses the Claude `Agent` tool and `Workflow` primitives.

**Claude Code mechanism:** `capabilities.subAgents = true` (`claude-code.js:66`). `src/parallel-broker.js:32-39` spawns child `run-agent.js` processes with IPC; `src/run-parallel.js` coordinates them. `lib/fan-out.js` splits prompts into per-subtask payloads.

**Copilot behaviour:** `capabilities.subAgents = false` (`github-copilot.js:98`). The `copilot` CLI has no sub-agent spawn primitive. `spawnCopilot()` is a single-shot process; no IPC, no `Agent`/`Workflow` tool equivalents.

**Downstream harness impact:** `src/parallel-broker.js`, `src/run-parallel.js`, `lib/fan-out.js` — all parallel execution paths are broken. `plan-code` and `all` pipelines that fan out coding sub-tasks run sequentially at best, or fail entirely if the broker attempts IPC with Copilot child processes.

**Workaround:** Serialise all sub-tasks into a single monolithic prompt. Loses parallelism and may exceed context limits for large task sets.

---

## 4. Auto-Resume — Token-Reset Detection and Rescheduling

**Feature:** On token quota exhaustion, harness detects the reset time from Claude's stderr, schedules a `schtasks`/`at` wake job, and resumes the exact failed pipeline phase automatically.

**Claude Code mechanism:** `capabilities.autoResume = true` (`claude-code.js:67`). `detectTokenReset()` (`claude-code.js:17-24`) parses `"resets at HH:MM (TZ)"` from stderr. On match, `claude-code.js:218` sets `err.tokenReset`; `run-agent.js` catches this to enqueue `.state/wake-queue.json`. `src/auto-resume.js` is the scheduled wake handler.

**Copilot behaviour:** `capabilities.autoResume = false` (`github-copilot.js:99`). Quota exhaustion surfaces as `error_quota` via `parseCopilotLogEntry()` (`github-copilot.js:55-65`). No reset-time string is parsed; no rescheduling hook exists. `parseStream()` emits `{ type: 'error', content: { code: 'error_quota' } }` and terminates (`github-copilot.js:279-289`).

**Downstream harness impact:** `src/auto-resume.js` — entirely inert for Copilot runs. Token exhaustion is a hard stop with no recovery. Pro quota (300 premium req/mo) and Business quota (1500/mo) are unrecoverable until the next billing period.

**Workaround:** None automated. User must manually retry the pipeline after quota resets. Monitor `error_quota` events and surface a manual-retry instruction.

---

## 5. Stream-JSON Live Output — Heartbeat and Token Streaming

**Feature:** Claude streams `--output-format stream-json` events during execution, enabling live token display, heartbeat keepalive, and mid-run progress.

**Claude Code mechanism:** `capabilities.streamJson = true` (`claude-code.js:68`). `claude-code.js:157` passes `--output-format stream-json` to the CLI. `parseStream()` (`claude-code.js:74-86`) processes lines as they arrive. Heartbeat timer (`claude-code.js:129-143`) resets on each chunk; CLI watchdog (`claude-code.js:146-152`) writes `still working...` every second if the CLI stalls.

**Copilot behaviour:** `capabilities.streamJson = false` (`github-copilot.js:100`). `spawnCopilot()` (`github-copilot.js:148-169`) writes `--log-dir` JSONL post-exit. `parseStream()` (`github-copilot.js:200`) reads the log dir only after the process closes. No stdout events during execution — `stdio: ['ignore', 'pipe', 'pipe']` with no line-by-line handler.

**Downstream harness impact:** `src/run-agent.js` — no live token counter, no heartbeat `still working...` output, no mid-run progress. User sees nothing until the process exits. Long runs appear hung. Token usage only available post-exit, and `cost_usd` is always `null` (`github-copilot.js:322`).

**Workaround:** Add a periodic `process.stdout.write` timer before `spawnCopilot()` returns, driven by wall-clock elapsed time. No actual content streaming possible.

---

## 6. Hooks — `settings.json` Hook Execution

**Feature:** Claude Code executes shell hooks defined in `settings.json` (e.g., `pre-tool-use`, `post-tool-use`, `stop`) automatically during agent runs.

**Claude Code mechanism:** `capabilities.hooks = true` (`claude-code.js:69`). The Claude CLI reads `.claude/settings.json` and `.claude/settings.local.json` at startup and fires hooks at lifecycle events. Harness relies on hooks for editor-buffer-flush (`src/editor-buffer-flush.js`), sound (`src/sound.js`), and post-run triggers.

**Copilot behaviour:** `capabilities.hooks = false` (`github-copilot.js:101`). `spawnCopilot()` has no settings-file injection; Copilot CLI does not honour `.claude/settings.json`. Hooks are never invoked.

**Downstream harness impact:** `src/editor-buffer-flush.js`, `src/sound.js`, and any `settings.json`-defined post-run hooks — all silently skipped. Users relying on chime notifications or buffer-flush hooks get no feedback.

**Workaround:** Wrap `spawnCopilot()` call sites with explicit pre/post JS callbacks. Cannot replicate mid-run `pre-tool-use` / `post-tool-use` hooks with no streaming.

---

## 7. Permission Modes — Granular Allow/Deny Lists

**Feature:** Claude Code supports `--permission-mode plan|auto-edit|bypassPermissions` plus granular `--allow`/`--disallow` tool lists, enabling fine-grained tool gating per pipeline phase.

**Claude Code mechanism:** `capabilities.permissionMode = true` (`claude-code.js:70`). `run-agent.js` constructs per-phase permission flags and passes them to the Claude CLI.

**Copilot behaviour:** `capabilities.permissionMode = false` (`github-copilot.js:102`). `spawnCopilot()` (`github-copilot.js:152`) hard-codes `--allow-all-tools` with no alternative. No deny lists, no phase-level restriction.

**Downstream harness impact:** `src/run-agent.js` — all phase-specific permission gating is bypassed. Every phase (planning, coding, assessment, fix) runs with full tool access. Accidental file mutations during planning/assessment phases are not prevented.

**Workaround:** Prompt-engineering only — instruct the model not to write files in read-only phases. Not enforceable at the CLI level.

---

## 8. Session Continuity — `session_id` and Memory Threading

**Feature:** Claude Code returns a stable `session_id` that `auto-resume.js` and `compress-memory.js` use to resume interrupted runs and thread conversation context.

**Claude Code mechanism:** `capabilities.autoResume = true` (`claude-code.js:67`). `run-agent.js` passes `--session-id <uuid>` (`claude-code.js:157`), and the harness writes session state to `.state/sessions/<sessionId>/`.

**Copilot behaviour:** `parseStream()` always emits `session_id: null` in the `done` event (`github-copilot.js:216`, `github-copilot.js:287`, `github-copilot.js:328`). No `--session-id` flag is passed. Each `spawnCopilot()` call is a fresh, isolated context.

**Downstream harness impact — auto-resume:** `src/auto-resume.js` — cannot re-attach to an interrupted run. Multi-turn `continue` pipeline phases (`run-agent.js` `continue` command) lose all prior context; model starts cold each phase.

**Downstream harness impact — memory compression:** `src/compress-memory.js` — cannot reference a prior session to compact accumulated context. Each Copilot phase starts from raw history reconstructed manually; no incremental compression possible. This is a distinct downstream failure from resumption: even a run that completes without interruption loses inter-phase memory threading.

**Workaround:** Manually prepend prior conversation history into each phase's prompt payload. Increases token cost; context window limits apply.

---

## Summary Table

| Feature | `claude-code` | `github-copilot` | Harness Component Affected |
|---|---|---|---|
| `planMode` | `true` | `false` | `src/run-agent.js` — plan-code / all pipelines |
| `skillsRuntime` | `true` | `false` | `skills/caveman`, `skills/interrogate`, `skills/strict-assessment` |
| `subAgents` | `true` | `false` | `src/parallel-broker.js`, `src/run-parallel.js`, `src/lib/fan-out.js` |
| `autoResume` | `true` | `false` | `src/auto-resume.js` — re-attach, token-reset detection (`claude-code.js:17-24`) |
| Session threading | Stable UUID | Always `null` | `src/compress-memory.js` — inter-phase context compaction broken |
| `cost_usd` | Populated | Always `null` (`github-copilot.js:322`) | Any downstream logic branching on cost threshold silently receives `null` |
| `streamJson` | `true` | `false` | Heartbeat / live token output in `src/run-agent.js` |
| `hooks` | `true` | `false` | `src/editor-buffer-flush.js`, `src/sound.js`, `settings.json` hooks |
| `permissionMode` | `true` | `false` | Phase-level tool gating in `src/run-agent.js` |
| `mcp` | `true` | `true` | Both support MCP via `--mcp-config` — convergence point, not a gap |
| `tools` | `true` | `true` | Both support native tool use — convergence point, not a gap |
| Live streaming | `--output-format stream-json` | Post-exit `--log-dir` JSONL only | Heartbeat, live token counter |
| Quota recovery | Auto-reschedule via `detectTokenReset` | Hard stop — `error_quota`, no reset time | `src/auto-resume.js` |
| Permission granularity | `--permission-mode` + `--allow`/`--disallow` | `--allow-all-tools` only | Phase safety gates in `src/run-agent.js` |
