# Gemini Provider — Harness Feature Gap Report

> **Important:** `parseGeminiLogEntry()` field mappings in `src/lib/providers/gemini.js:14-77` are marked **[NEEDS-VERIFICATION]** against real CLI output. Field names (`entry.text`, `entry.content`, `entry.type` values, ratelimit header paths, etc.) are planning-agent assumptions about `@google/gemini-cli` (post knowledge-cutoff). The `--yolo` flag (non-interactive auto-approve) and `--log-dir` flag (post-exit JSONL logging) are both **[NEEDS-VERIFICATION]** — probe `gemini --help` and inspect a sample run before trusting these. The gap list below may grow once the CLI is probed.
>
> **Note on gemini-vertex:** `src/lib/providers/gemini-vertex.js` shares the same `capabilities` object (all advanced features `false`) and the same `parseStream` / `parseGeminiLogEntry` logic as the base `gemini` provider. Every gap below applies equally to `gemini-vertex` unless noted. Vertex-specific gaps are called out in each section.

---

## 1. Plan Mode — Two-Pass Gate

**Feature:** Read-only planning pass enforced via `--permission-mode plan` before the coding pass executes file writes.

**Claude Code mechanism:** `run-agent.js` resolves `--permission-mode plan` flag and passes it to the Claude CLI on the first pass. Only after plan approval does the coding pass run with full permissions. Controlled by `capabilities.planMode = true` (`claude-code.js:64`).

**Gemini behaviour:** `capabilities.planMode = false` (`gemini.js:96`). `spawn_()` (`gemini.js:198`) passes only `-p`, `--yolo`, `--log-dir`, and optionally `--model` — no permission-mode flag exists in the Gemini CLI. Same for `gemini-vertex.js:146`.

**Downstream harness impact:** `src/run-agent.js` — the `plan-code` and `all` pipeline commands cannot enforce a read-only planning pass. The planning agent runs with full tool access (via `--yolo`), eliminating the two-pass safety gate.

**Workaround:** Compose the planning prompt to instruct the model to emit a plan only (no file edits), then manually review before triggering the coding phase. No CLI-level enforcement possible.

---

## 2. Skills Runtime — Native Skill Loading

**Feature:** Harness skills (`/caveman`, `/interrogate`, `/strict-assessment`) are auto-loaded by the Claude Code runtime from `skills/` directories during spawn.

**Claude Code mechanism:** `capabilities.skillsRuntime = true` (`claude-code.js:65`). The Claude CLI resolves skill definitions from `CLAUDE.md` and adjacent `skills/` dirs at startup via the `Skill` tool infrastructure.

**Gemini behaviour:** `capabilities.skillsRuntime = false` (`gemini.js:97`). `spawn_()` accepts only `-p`, `--yolo`, `--log-dir`, and `--model`. No skill-directory injection path exists in the Gemini CLI.

**Downstream harness impact:** Skills defined under `Agent_Orchestrator/skills/caveman/`, `skills/interrogate/`, `skills/strict-assessment/` are silently ignored. Interrogation gating (`## Clarifying Questions` header pause), caveman compression, and strict-assessment scoring all fail silently.

**Workaround:** Inline skill content (`SKILL.md` body) verbatim into the prompt payload before spawn. Increases token cost per call; no interactive skill invocation during a run.

---

## 3. Sub-Agents and Parallel Broker

**Feature:** Harness spawns multiple parallel agents via `parallel-broker.js` / `run-parallel.js`, coordinated by `lib/fan-out.js`. Each sub-agent uses the Claude `Agent` tool and `Workflow` primitives.

**Claude Code mechanism:** `capabilities.subAgents = true` (`claude-code.js:66`). `src/parallel-broker.js:32-39` spawns child `run-agent.js` processes with IPC; `src/run-parallel.js` coordinates them. `lib/fan-out.js` splits prompts into per-subtask payloads.

**Gemini behaviour:** `capabilities.subAgents = false` (`gemini.js:98`). The Gemini CLI has no sub-agent spawn primitive equivalent to Claude's `Agent` or `Workflow` tools. `spawn_()` is a single-shot process; no IPC, no native multi-agent fan-out.

**Downstream harness impact:** `src/parallel-broker.js`, `src/run-parallel.js`, `lib/fan-out.js` — all parallel execution paths are broken. `plan-code` and `all` pipelines that fan out coding sub-tasks run sequentially at best, or fail entirely if the broker attempts IPC with Gemini child processes.

**Workaround:** Serialise all sub-tasks into a single monolithic prompt. Loses parallelism and may exceed context limits for large task sets.

---

## 4. Auto-Resume — Token-Reset Detection and Rescheduling

**Feature:** On token quota exhaustion, harness detects the reset time from Claude's stderr, schedules a `schtasks`/`at` wake job, and resumes the exact failed pipeline phase automatically.

**Claude Code mechanism:** `capabilities.autoResume = true` (`claude-code.js:67`). `detectTokenReset()` (`claude-code.js:17-24`) parses `"resets at HH:MM (TZ)"` from stderr. On match, `claude-code.js:218` sets `err.tokenReset`; `run-agent.js` catches this to enqueue `.state/wake-queue.json`. `src/auto-resume.js` is the scheduled wake handler.

**Gemini behaviour:** `capabilities.autoResume = false` (`gemini.js:99`). Quota exhaustion is detected post-exit via `parseGeminiLogEntry()` type matching (`gemini.js:55-65`) and stderr regex (`gemini.js:357-362`). No reset-time string is parsed from the Gemini CLI; no rescheduling hook exists. `parseStream()` emits `{ type: 'error', content: { code: 'error_quota' } }` and terminates.

**Downstream harness impact:** `src/auto-resume.js` — entirely inert for Gemini runs. Quota exhaustion (AI Studio free tier, Code Assist limits, Vertex AI quotas) is a hard stop with no automated recovery.

**Vertex-specific note:** Vertex AI quota errors surface with different patterns (`rate.?limit` in stderr) matched at `gemini-vertex.js:266`. Reset time is not available from Vertex AI error responses either — same dead end.

**Workaround:** None automated. User must manually retry the pipeline after quota resets. Monitor `error_quota` events and surface a manual-retry instruction.

---

## 5. Stream-JSON Live Output — Heartbeat and Token Streaming

**Feature:** Claude streams `--output-format stream-json` events during execution, enabling live token display, heartbeat keepalive, and mid-run progress.

**Claude Code mechanism:** `capabilities.streamJson = true` (`claude-code.js:68`). `claude-code.js:157` passes `--output-format stream-json` to the CLI. `parseStream()` (`claude-code.js:74-86`) processes lines as they arrive. Heartbeat timer (`claude-code.js:129-143`) resets on each chunk; CLI watchdog writes `still working...` every second if the CLI stalls.

**Gemini behaviour:** `capabilities.streamJson = false` (`gemini.js:100`). `spawn_()` (`gemini.js:198`) passes `--log-dir` for post-exit JSONL. Stdout is buffered via `getStdout()` only as a fallback when `--log-dir` is unsupported (`gemini.js:273-283`). No line-by-line streaming handler exists — `parseStream()` is called only after process close.

**Additional risk:** Both `--yolo` and `--log-dir` are marked `[NEEDS-VERIFICATION]` (`gemini.js:196-197`). If `--log-dir` is unsupported in the installed CLI version, the fallback path (`stdoutBuf`) produces `input_tokens: null`, `output_tokens: null`, `cost_usd: null` for all runs — entirely dark telemetry.

**Downstream harness impact:** `src/run-agent.js` — no live token counter, no heartbeat `still working...` output, no mid-run progress. User sees nothing until the process exits. Long runs appear hung. Token usage may be entirely `null` depending on CLI version.

**Workaround:** Add a periodic `process.stdout.write` timer before `spawn_()` returns, driven by wall-clock elapsed time. No actual content streaming possible. Probe `gemini --help` to confirm `--log-dir` is supported before relying on JSONL telemetry.

---

## 6. Hooks — `settings.json` Hook Execution

**Feature:** Claude Code executes shell hooks defined in `settings.json` (e.g., `pre-tool-use`, `post-tool-use`, `stop`) automatically during agent runs.

**Claude Code mechanism:** `capabilities.hooks = true` (`claude-code.js:69`). The Claude CLI reads `.claude/settings.json` at startup and fires hooks at lifecycle events. Harness relies on hooks for editor-buffer-flush (`src/editor-buffer-flush.js`), sound (`src/sound.js`), and post-run triggers.

**Gemini behaviour:** `capabilities.hooks = false` (`gemini.js:101`). `spawn_()` has no settings-file injection; the Gemini CLI does not honour `.claude/settings.json`. Hooks are never invoked.

**Downstream harness impact:** `src/editor-buffer-flush.js`, `src/sound.js`, and any `settings.json`-defined post-run hooks — all silently skipped. Users relying on chime notifications or buffer-flush hooks get no feedback.

**Workaround:** Wrap `spawn_()` call sites with explicit pre/post JS callbacks. Cannot replicate mid-run `pre-tool-use` / `post-tool-use` hooks with no streaming.

---

## 7. Permission Modes — Granular Allow/Deny Lists

**Feature:** Claude Code supports `--permission-mode plan|auto-edit|bypassPermissions` plus granular `--allow`/`--disallow` tool lists, enabling fine-grained tool gating per pipeline phase.

**Claude Code mechanism:** `capabilities.permissionMode = true` (`claude-code.js:70`). `run-agent.js` constructs per-phase permission flags and passes them to the Claude CLI.

**Gemini behaviour:** `capabilities.permissionMode = false` (`gemini.js:102`). `spawn_()` (`gemini.js:198`) hard-codes `--yolo` (assumed non-interactive auto-approve) with no alternative. `[NEEDS-VERIFICATION]` — the `--yolo` flag name and its scope (whether it maps to "all tools allowed" or something narrower) is unconfirmed. No deny lists, no phase-level restriction.

**Downstream harness impact:** `src/run-agent.js` — all phase-specific permission gating is bypassed. Every phase (planning, coding, assessment, fix) runs with full tool access. Accidental file mutations during planning/assessment phases are not prevented.

**Workaround:** Prompt-engineering only — instruct the model not to write files in read-only phases. Not enforceable at the CLI level.

---

## 8. Session Continuity — `session_id` and Memory Threading

**Feature:** Claude Code returns a stable `session_id` that `auto-resume.js` and `compress-memory.js` use to resume interrupted runs and thread conversation context.

**Claude Code mechanism:** `capabilities.autoResume = true` (`claude-code.js:67`). `run-agent.js` passes `--session-id <uuid>` and the harness writes session state to `.state/sessions/<sessionId>/`.

**Gemini behaviour:** `parseStream()` always emits `session_id: null` in the `done` event (`gemini.js:265`, `gemini.js:282`, `gemini.js:392`). No `--session-id` equivalent flag is passed. Each `spawn_()` call is a fresh, isolated context. Same for `gemini-vertex.js:191`, `gemini-vertex.js:204`, `gemini-vertex.js:292`.

**Downstream harness impact — auto-resume:** `src/auto-resume.js` — cannot re-attach to an interrupted run. Multi-turn `continue` pipeline phases lose all prior context; model starts cold each phase.

**Downstream harness impact — memory compression:** `src/compress-memory.js` — cannot reference a prior session to compact accumulated context. Each Gemini phase starts from raw history reconstructed manually; no incremental compression possible. This is a distinct failure from resumption: even a run that completes without interruption loses inter-phase memory threading.

**Workaround:** Manually prepend prior conversation history into each phase's prompt payload. Increases token cost; context window limits apply.

---

## 9. Auth Surface Complexity — Three Auth Paths, Silent Mismatch

**Feature (Gemini-specific gap not present in Copilot):** Gemini exposes three distinct auth surfaces across two provider modules. Misconfiguration produces a silent wrong-provider spawn, not a clear error.

**Mechanism:** `detectAuthSurface()` (`gemini.js:120-124`) returns:
- `'ai-studio'` if `GEMINI_API_KEY` is set
- `'vertex-redirect'` if `GOOGLE_CLOUD_PROJECT` is set but no `GEMINI_API_KEY`
- `'code-assist'` (assumed OAuth via `gemini auth`) otherwise

**Gap:** When `GOOGLE_CLOUD_PROJECT` is set without `GEMINI_API_KEY`, `probe()` (`gemini.js:131-136`) emits a `[WARN]` to stderr and returns `false` — but only if `probe()` is called explicitly. If `global-config.json` specifies `"provider": "gemini"` while `GOOGLE_CLOUD_PROJECT` is set, the harness may proceed to `spawn_()` with an auth mismatch depending on how the registry calls `probe()`. The correct provider in that configuration is `"gemini-vertex"`.

**Downstream harness impact:** `src/lib/providers/registry.js` — if probe-before-spawn is not enforced by the registry, Vertex AI workloads run under the wrong auth surface and fail at the API boundary, not at harness startup where the error is diagnosable.

**Workaround:** Document in `global-config.json` comments that `GOOGLE_CLOUD_PROJECT` + ADC → `"provider": "gemini-vertex"`, `GEMINI_API_KEY` → `"provider": "gemini"`. Enforce `probe()` before any `spawn_()` call in the registry.

---

## 10. Cost Telemetry — `cost_usd` Always Null

**Feature:** Claude Code populates `cost_usd` in the `usage` event for downstream budget-guard logic.

**Claude Code mechanism:** `cost_usd` is returned in the `result` event from `--output-format stream-json` and parsed at `claude-code.js:82`.

**Gemini behaviour:** `cost_usd: null` is hard-coded in every `usage` event emitted by `parseStream()` (`gemini.js:279`, `gemini.js:387`). Same for `gemini-vertex.js:203`, `gemini-vertex.js:285`. The Gemini CLI does not surface per-call USD cost.

**Downstream harness impact:** Any harness logic that branches on `cost_usd` threshold (e.g., cost-guard in `run-agent.js`) silently receives `null` for all Gemini runs. No budget enforcement is possible.

**Workaround:** Use `input_tokens` + `output_tokens` as a proxy. These may also be `null` if `--log-dir` is unsupported — see gap 5.

---

## Summary Table

| Feature | `claude-code` | `gemini` / `gemini-vertex` | Harness Component Affected |
|---|---|---|---|
| `planMode` | `true` | `false` | `src/run-agent.js` — plan-code / all pipelines |
| `skillsRuntime` | `true` | `false` | `skills/caveman`, `skills/interrogate`, `skills/strict-assessment` |
| `subAgents` | `true` | `false` | `src/parallel-broker.js`, `src/run-parallel.js`, `src/lib/fan-out.js` |
| `autoResume` | `true` | `false` | `src/auto-resume.js` — re-attach, token-reset detection |
| Session threading | Stable UUID | Always `null` (`gemini.js:392`) | `src/compress-memory.js` — inter-phase context compaction broken |
| `cost_usd` | Populated | Always `null` (`gemini.js:387`) | Budget-guard logic receives `null` silently |
| `streamJson` | `true` | `false` | Heartbeat / live token output in `src/run-agent.js` |
| `hooks` | `true` | `false` | `src/editor-buffer-flush.js`, `src/sound.js`, `settings.json` hooks |
| `permissionMode` | `true` | `false` | Phase-level tool gating in `src/run-agent.js` |
| `mcp` | `true` | `true` **[NEEDS-VERIFICATION]** | Gemini CLI `--mcp-config` flag is post-knowledge-cutoff — same uncertainty as `--yolo`/`--log-dir`; verify before treating as a convergence point |
| `tools` | `true` | `true` | Both support native tool use — convergence point, not a gap |
| Live streaming | `--output-format stream-json` | Post-exit `--log-dir` JSONL only (unverified) | Heartbeat, live token counter |
| Quota recovery | Auto-reschedule via `detectTokenReset` | Hard stop — `error_quota`, no reset time | `src/auto-resume.js` |
| Permission granularity | `--permission-mode` + `--allow`/`--disallow` | `--yolo` only (unverified flag name) | Phase safety gates in `src/run-agent.js` |
| Auth surface | Single (Anthropic) | Three: AI Studio / Code Assist / Vertex | `registry.js` — wrong-provider silent mismatch risk |
| `--log-dir` / JSONL telemetry | N/A (stream-json) | **[NEEDS-VERIFICATION]** — may be unsupported | `parseStream()` falls back to raw stdout → all tokens `null` |
| `--yolo` flag | N/A | **[NEEDS-VERIFICATION]** — assumed non-interactive flag | `spawn_()` may fail or prompt if flag is wrong |

---

## Recommended Remediation Order

1. **(Blocker) Probe `--yolo` and `--log-dir` flags** — run `gemini --help` and a sample `gemini -p "hello" --yolo --log-dir /tmp/test` and inspect the log dir. Patch `gemini.js:198` / `gemini-vertex.js:146` if flags differ. All other gaps compound if spawn itself is broken.

2. **(Blocker) Enforce `probe()` before `spawn_()` in registry** — `detectAuthSurface()` must gate spawn to prevent silent Vertex-under-gemini-provider mismatch (`gemini.js:131-136`). Confirm `registry.js` calls `probe()` and aborts on `false`.

3. **(Risk) Inline skills into prompt payload** — `skillsRuntime = false` means interrogation gating, strict-assessment, and caveman compression are all silent no-ops. `injectSkillsInline()` already exists in `src/lib/providers/github-copilot.js:399-424` and reads `skills/caveman/SKILL.md`, `skills/interrogate/SKILL.md`, and `skills/strict-assessment/SKILL.md`. Extract this function to a shared utility (e.g. `src/lib/inject-skills.js`) and call it from the Gemini `spawn_()` path instead of duplicating it.

4. **(Risk — resolved) Serial fallback for parallel broker** — `subAgents = false` means parallel fan-out is unsupported. `src/parallel-broker.js:173-203` already implements a serial branch (`spawnNextSequential()`) that activates when `provider.capabilities.subAgents === false`. No code change needed; verify `run-parallel.js` passes the active provider capabilities object through to `createBroker()`.

5. **(Risk) Plan-phase prompt guard** — `planMode = false` means `plan-code` pipeline runs planning with full write access. Add a prompt-level guard injected by `run-agent.js` when `planMode = false`: instruct the model to output plan text only and not invoke file-write tools.

6. **(Nit) `cost_usd` null guard** — any downstream `cost_usd` threshold logic should treat `null` as "unknown, do not gate" rather than zero. Audit `run-agent.js` for `cost_usd` comparisons.

7. **(Nit) Quota surface manual-retry message** — `autoResume = false` means quota exhaustion is a silent hard stop. `parseStream()` already emits `error_quota`; have `run-agent.js` print a human-readable retry instruction when it receives that event from a Gemini provider.
