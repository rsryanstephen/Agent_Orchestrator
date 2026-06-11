# Provider Abstraction Design

Design doc for decoupling the harness from Claude Code so alternative backends (GitHub Copilot CLI, Gemini CLI) can be plugged in. No code changes this round — purely design + capability matrix + decision log.

Folder rename `Agent_Orchestrator/` (previously `Claude_Code_Harness/`) completed; grep audit listed at bottom retained for historical reference.

---

## 1. Claude-tied surfaces (catalog)

Every surface that currently assumes Claude Code. Each row = (current impl, Copilot equivalent, Gemini equivalent, gap severity).

| #  | Surface                                                                                                      | Current impl (file/symbol)                                                                                                                                       | Copilot CLI equivalent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Gemini CLI equivalent                                                                                                                         | Gap severity                                                                       |
| -- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1  | CLI spawn + flags                                                                                            | `run-agent.js::runClaude` — `claude --print --output-format=stream-json --model X --permission-mode Y --mcp-config Z`, resume tokens, network-retry wrapper | **Standalone `copilot` CLI** (GitHub Copilot CLI, public preview Oct 2025) — `copilot -p "<prompt>" --allow-all-tools --mcp-config <path>` — no `--output-format=stream-json`; structured output via `--log-dir <dir>` JSONL logs instead of stdout blob. On Windows ships as `copilot.cmd`. Model selection via `/model` slash-command or `--model` flag (claude-sonnet-4.5, gpt-5, etc.). **NOT** `gh copilot` extension (only `suggest`/`explain`, non-agentic, deprecated). | `gemini -p "<prompt>" --model gemini-2.5-pro --yolo` — JSON via `--output-format json` (one-shot, not stream). MCP via `--mcp-config`. | **High** (stream-json absent on Copilot)                                     |
| 2  | Agent subtypes (`Agent` tool: `Explore`/`Plan`/`general-purpose`)                                    | Tool list at top of `run-agent.js` system prompt; recursive `claude` spawn under the hood                                                                    | None. Copilot is single-shot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | None native. Could emulate via recursive `gemini -p`.                                                                                       | **High** (no native sub-agent on either)                                     |
| 3  | MCP tools +`ToolSearch` (deferred-tool fetch)                                                              | Claude built-in MCP loader; deferred-tool schema fetch via `ToolSearch`                                                                                        | ✓ MCP via `--mcp-config <path>`; verify with `/mcp` slash-command inside CLI. No deferred-tool schema fetch.                                                                                                                                                                                                                                                                                                                                                                                                 | Experimental MCP support via `--mcp-config <path>`; no deferred-tool schema fetch                                                           | **Medium** for Copilot (MCP supported, no deferred-fetch), Medium for Gemini |
| 4  | Skills (`.claude/skills/`, `Skill` tool, user-invocable list)                                            | `~/.claude/skills/*/SKILL.md` auto-discovered; `Skill` tool dispatches                                                                                       | No skill runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | No skill runtime                                                                                                                              | **High** — must inline skill bodies                                         |
| 5  | Hooks (`settings.json` hook events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, etc.) | Claude harness fires hooks; configured in `~/.claude/settings.json`                                                                                            | No hooks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | No hooks                                                                                                                                      | **High** — harness-level reimpl needed                                      |
| 6  | Slash commands                                                                                               | Claude built-in (`/clear`, `/help`, plus skill-backed `/<skill>`)                                                                                          | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `gemini` has `/` REPL commands but not headless                                                                                           | **Medium** — only matters for interactive                                   |
| 7  | Plan mode (`EnterPlanMode`/`ExitPlanMode`)                                                               | Claude tool gates writes until plan approved                                                                                                                     | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | None                                                                                                                                          | **Medium** — emulate via two-pass prompt                                    |
| 8  | Worktrees (`EnterWorktree`, `Agent({isolation:'worktree'})`)                                             | git-level — Claude tool calls `git worktree add` then chdirs                                                                                                  | Provider-agnostic — keep as-is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Provider-agnostic — keep as-is                                                                                                               | **None** — already portable                                                 |
| 9  | Transcript format (stream-json events,`agent-<id>.jsonl`, `TaskCreate`/`TaskOutput`)                   | `run-agent.js` parses `event.type === "assistant"/"tool_use"/"tool_result"/"result"`                                                                         | Copilot: no events, only final text                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Gemini `--output-format json`: single object with `response`, `usageMetadata`, `toolCalls[]` — not streamed                          | **High** — need provider-neutral normalized JSONL                           |
| 10 | Usage stats parser (`show-usage-stats`, token + cache counters)                                            | Reads `event.message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` from final `result` event                    | None exposed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount}`                                                           | **Medium** (Copilot null), **Low** (Gemini mappable)                   |
| 11 | Memory system (`MEMORY.md`, `~/.claude/CLAUDE.md`, auto-memory dir)                                      | Claude auto-loads `CLAUDE.md` + per-project memory dir; harness writes via `Write` tool                                                                      | No equivalent — system prompt only                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `GEMINI.md` auto-loaded from cwd hierarchy; no project-scoped auto-memory dir                                                               | **Medium** — inline into system prompt fallback                             |
| 12 | Settings + permissions (`settings.json`, `.claude/settings.local.json`, `permission-mode`)             | Claude reads + enforces                                                                                                                                          | No permission system — Copilot just runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `--yolo` flag bypasses approval; otherwise interactive only (headless = `--yolo`)                                                         | **High** — harness must enforce                                             |
| 13 | Model IDs (`models-reference.md`, `claude-opus-4-7` strings)                                             | Hardcoded model strings                                                                                                                                          | `copilot` uses GitHub-managed model (no user choice in CLI)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `gemini-2.5-pro`, `gemini-2.5-flash`                                                                                                      | **Medium** — registry per provider                                          |
| 14 | Auto-resume token-limit recovery (`auto-resume.js`)                                                        | Detects `result.subtype === "error_max_turns"` / token-limit, resumes with `claude --resume <session-id>`                                                    | No session resume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | No session resume                                                                                                                             | **High** — disable + warn                                                   |
| 15 | Editor-save-flush + terminal spawn (`editor-buffer-flush.js`, shell-functions)                             | OS-level — independent of provider                                                                                                                              | Same                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Same                                                                                                                                          | **None**                                                                     |
| 16 | Login / auth prompts                                                                                         | `claude` interactive login on first run; auth via `~/.claude/auth.json`                                                                                      | `gh auth login` (separate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `gemini auth` / `GEMINI_API_KEY` env                                                                                                      | **Low** — provider-specific probe + instruction string                      |

---

## 2. Proposed abstraction

Single interface, three concrete impls, registry keyed by config.

### Interface — `lib/providers/Provider.js`

```js
class Provider {
  spawn(opts)                  // { prompt, model, mcpConfig, permissionMode, resumeToken, cwd } -> ChildProcess
  streamParser(stdout)         // async iterator yielding normalized events
  extractUsage(events)         // { inputTokens, outputTokens, cacheRead, cacheCreate } | null
  extractResumeToken(events)   // string | null
  supportsFeature(name)        // bool — 'mcp' | 'tools' | 'skills' | 'plan-mode' | 'sub-agent' | 'stream-json' | 'resume' | 'permission-mode' | 'hooks'
  formatSystemPrompt(text)     // provider-specific framing (e.g. prepend GEMINI.md path, inline skills, etc.)
  loginInstructions()          // human-readable string shown when auth probe fails
  modelCatalog()               // { defaultByRole, all: [...] }
  defaultModel(role)           // 'planning' | 'coding' | 'assessment' -> model id
}
```

### Concrete impls

- `lib/providers/claude-code.js` — current behavior (extracted from `run-agent.js::runClaude`)
- `lib/providers/copilot.js` — GitHub Copilot CLI (`copilot` standalone, public preview Oct 2025 — **NOT** `gh copilot` legacy extension). `supportsFeature` returns `true` for `mcp` (via `--mcp-config`), `tools` (file edits, `--allow-all-tools`). Returns `false` for `stream-json` (log-dir JSONL, not stdout stream), `skills`, `plan-mode`, `sub-agent`, `resume`, `permission-mode`, `hooks`. `streamParser` reads `--log-dir` JSONL files rather than stdout blob. Emits real `tool_call`/`tool_result` events from log entries; synthesizes `usage` with token fields from log (or `null` if absent). On Windows, binary is `copilot.cmd` — apply same `.cmd` retry guard used for `code.cmd` in `flushEditorBuffers`. AGENTS.md auto-loaded from repo root + `.github/copilot-instructions.md`; harness generates `AGENTS.md` from CLAUDE.md + MEMORY at spawn time.
- `lib/providers/gemini.js` — Gemini CLI (`gemini -p ... --output-format json --yolo`). `supportsFeature('mcp')` true; `stream-json` false (one-shot JSON); `resume` false.

### Registry — `lib/providers/index.js`

```js
const PROVIDERS = {
  'claude-code': require('./claude-code'),
  'github-copilot': require('./copilot'),
  'gemini': require('./gemini'),
}
function getProvider() {
  const id = require('../../config-utils').load().provider || 'claude-code'
  if (!PROVIDERS[id]) throw new Error(`Unknown provider: ${id}`)
  return PROVIDERS[id]
}
```

### Call-site swap inventory

Every place `runClaude` (or equivalent) is currently called and must switch to `getProvider().spawn(...)`:

- `run-agent.js::runPlanning`
- `run-agent.js::runCoding`
- `run-agent.js::runCodingFromPlan`
- `run-agent.js::runCodingAssessment`
- `run-agent.js::runAssessment`
- `auto-resume.js` — gated on `supportsFeature('resume')`; short-circuits with `[WARN] auto-resume not supported under provider <id>` if false
- `parallel-broker.js` — fan-out wrapper, swap `runClaude` calls
- `prompt-queue.js` — uses `runClaude` for queue draining
- `update-models-reference.js` — replace with `provider.modelCatalog()`
- `schedule-models-refresh.js` — same

### Unsupported-feature runtime enforcement

Every call site checks `supportsFeature(name)` **before** invoking. If false:

```js
if (!provider.supportsFeature('mcp')) {
  console.warn(`[WARN] MCP unavailable under provider ${provider.id}; skipping mcpConfig`)
}
```

No silent no-op. Always log + degrade.

---

## 3. Config strategy

Single `global-config.json` retains today's schema; add new top-level key:

```jsonc
{
  "provider": "claude-code",   // | "github-copilot" | "gemini"
  // ... existing keys ...
}
```

Default `"claude-code"`.

### Per-provider overrides

Sibling files: `Agent_Orchestrator/providers/<id>/config.json` — merged **after** global, **before** topic-config.

Example `providers/gemini/config.json`:

```json
{
  "model-by-role": { "planning": "gemini-2.5-pro", "coding": "gemini-2.5-pro", "assessment": "gemini-2.5-flash" },
  "context-cache-ttl-seconds": 3600,
  "yolo-mode": true
}
```

Example `providers/github-copilot/config.json`:

```json
{
  "model-alias": "copilot-default"
}
```

### Validation + unsupported-key handling

On startup, `config-utils.js`:

1. Validates `provider` value against registry.
2. Calls `provider.probe()` (e.g. `claude --version` / `copilot --version` / `gemini --version`). On failure → print `provider.loginInstructions()` and exit non-zero.
3. For each config key the selected provider does not support, either:
   - Auto-inject a sibling `"// <key>"` comment string on first run, OR
   - Print `[WARN] config key <key> ignored under provider <id>`.

### Unsupported-key matrix (config → provider)

| Config key                    | claude-code | github-copilot                                                                    | gemini                          |
| ----------------------------- | ----------- | --------------------------------------------------------------------------------- | ------------------------------- |
| `permission-mode`           | ✓          | ✗                                                                                | ✗ (always yolo headless)       |
| `mcp-config`                | ✓          | ✓ (`--mcp-config` supported)                                                   | ✓ (experimental)               |
| `skills-dir`                | ✓          | ✗                                                                                | ✗ (inlined into system prompt) |
| `hooks`                     | ✓          | ✗                                                                                | ✗                              |
| `auto-resume`               | ✓          | ✗                                                                                | ✗                              |
| `model-by-role.planning`    | ✓          | ✓ (`/model` slash-cmd or `--model`; supports claude-sonnet-4.5, gpt-5, etc.) | ✓                              |
| `output-format=stream-json` | ✓          | ✗                                                                                | ✗ (json one-shot)              |
| `subagent-types`            | ✓          | ✗                                                                                | ✗                              |
| `plan-mode-gate`            | ✓          | ✗                                                                                | ✗ (emulate via two-pass)       |

---

## 4. Capability gap matrix + alternative plans

For each Claude-only feature, the proposed fallback. `[NEEDS-DECISION]` flags items requiring user input next round.

### MCP tools

- **Copilot:** standalone `copilot` CLI **does support MCP** — pass `--mcp-config <path>` at spawn. Verify via `/mcp` slash-command inside CLI. `[NEEDS-DECISION]` #1 (original shim question) is now moot for Copilot; close it.
- **Gemini:** experimental MCP → direct mapping via `--mcp-config`. Test reliability before committing.

### Skills + slash commands

- Neither has a runtime skill loader.
- Propose: at spawn time, harness reads `~/.claude/skills/*/SKILL.md` (or new `providers/<id>/skills/`) and inlines selected skill bodies into the system prompt with a size guard (e.g. max 8 KB total).
- `[NEEDS-DECISION]` which skills auto-inline vs. user-explicit-invoke.

### Plan mode

- No equivalents.
- Propose two-pass prompt: planning agent returns a plan inside `<plan>...</plan>` tags, harness pauses for user approval, coding agent runs only after approval. Already partially modeled by `runPlanning` → user gate → `runCoding` pipeline.
- No extra code needed if planning phase always gates.

### Worktrees

- Provider-agnostic (git-level). Keep as-is.

### Subagent `Agent` tool (Explore/Plan/general-purpose)

- No equivalent on Copilot or Gemini.
- Propose harness-level fan-out via sequential `provider.spawn()` calls coordinated by existing `parallel-broker.js` + `lib/parallel-semaphore.js`.
- `[NEEDS-DECISION]` whether to attempt structured-output JSON schema enforcement on Gemini (it supports `responseSchema`) — Copilot has no analog.

### Transcript format

- Write provider-neutral normalized JSONL (event types: `assistant_text`, `tool_call`, `tool_result`, `usage`, `error`, `done`).
- Store raw provider output under `providers/<id>/raw/<topic>/<role>-<timestamp>.jsonl` for debugging.
- `streamParser` per provider converts native → normalized.

### Usage stats

- Gemini exposes `usageMetadata` → map to normalized counters.
- Copilot exposes none → return `null`; UI row shows `—` instead of zeros.

### Auto-resume

- Claude-only. Disable + warn on other providers (`auto-resume.js` checks `provider.supportsFeature('resume')`).
- `[NEEDS-DECISION]` whether to attempt a manual "stitch two runs together" fallback on Gemini (probably no — added complexity for rare benefit).

### Hooks

- Claude-only. Harness-level emulation: wrap `provider.spawn()` with pre/post callbacks driven by a new `Agent_Orchestrator/hooks.json` (or rename to `harness/hooks.json`). Same event names: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`.
- `[NEEDS-DECISION]` priority — may be deferrable to phase-3.

---

## 5. Phase-2 folder rename audit

Completed rename `Claude_Code_Harness/` → `Agent_Orchestrator/`. Files that referenced the literal `Claude_Code_Harness` and were updated in the rename commit:

- `global-config.json` — `topic-files-dir`, any other paths
- `README.md`
- `Why delete CLAUDE.md...md`
- `shell-functions.txt`
- `install-shell-functions.js`
- `run-agent.js` (system prompts, path constants)
- `clear-memory.js`
- `remove-topic.js`
- `rename-topic.js`
- `set-topic.js`
- `start-topic.js`
- `normalize-history.js`
- `parallel-broker.js`
- `prompt-queue.js`
- `auto-resume.js`
- `editor-buffer-flush.js`
- `update-models-reference.js`
- `schedule-models-refresh.js`
- `compress-memory.js`
- `tests/**`
- `.claude/settings.json` / `.claude/settings.local.json` permission entries
- Any system-prompt string referencing `Agent_Orchestrator/topic_files/...`

Mitigation during transition (historical): a symlink (or junction on Windows) `Claude_Code_Harness` → `Agent_Orchestrator` could keep legacy shell aliases working until a follow-up commit removes the symlink.

**Critical — CI/clone migration (historical, pre-rename):** `git clone` does NOT recreate junctions or symlinks. Any CI runner or teammate who freshly clones the repo would have found `Claude_Code_Harness/` absent and every script using that path would have failed. A post-clone setup step MUST recreate the junction/symlink automatically. Options (pick one before shipping the rename):

- Add a `postinstall` script in `package.json`: `"postinstall": "node Agent_Orchestrator/install-shell-functions.js --create-junction"` (or a dedicated `setup.js`).
- Document a mandatory `npm run setup` in `README.md` and fail fast in `run-agent.js` startup if the expected path is absent.
- Use a cross-platform approach (e.g. a pre-commit or CI step that calls `node scripts/ensure-junction.js`) rather than relying on OS-level symlinks which require elevated permissions on Windows.

---

## 6. Open questions for next round (`[NEEDS-DECISION]` summary)

~~1. MCP tool shim scope for Copilot — full set or minimal (read/grep/edit/write/bash)?~~ **CLOSED** — Copilot standalone CLI supports MCP natively via `--mcp-config`; shim not needed. See §4.

1. Skills auto-inline policy — all skills or user-tagged subset?
2. Gemini structured-output via `responseSchema` — adopt for sub-agent emulation, or skip?
3. Hooks emulation — phase-2 alongside provider abstraction, or phase-3?
4. Folder rename — target name `Agent_Orchestrator/`, or alternative? Confirm.
5. Auto-resume manual stitching on Gemini — implement or hard-disable?
6. Per-provider config merge order — global → provider → topic; confirm precedence is correct.

---

## 7. Login / auth per provider

Each provider exposes `loginInstructions()` returning a literal string the harness prints on probe failure.

### claude-code

- Probe: `claude --version`
- Auth: interactive `claude` on first run; persists to `~/.claude/auth.json`
- Env override: `ANTHROPIC_API_KEY`
- Instruction string: `"Run 'claude' once interactively to sign in, or set ANTHROPIC_API_KEY in env. Docs: https://docs.claude.com/en/docs/claude-code/setup"`

### github-copilot

> **`[NEEDS-VERIFICATION]`** All CLI details below (`copilot --version`, `copilot auth login`, `~/.copilot/` path) are derived from planning-agent assumptions about a public-preview tool (Oct 2025, after knowledge cutoff). Verify against real docs before impl.

- **Target binary:** standalone `copilot` CLI (GitHub Copilot CLI, public preview Oct 2025). **NOT** `gh copilot` legacy extension (only `suggest`/`explain`, non-agentic — do not probe that).
- Probe: `copilot --version` (or `copilot.cmd --version` on Windows) `[NEEDS-VERIFICATION]`
- Auth: `/login` slash-command inside the CLI, or `copilot auth login` — credentials persisted to `~/.copilot/` (not `~/.config/gh/`) `[NEEDS-VERIFICATION]`
- Requires active Copilot subscription on the GitHub account. Subscription tier determines premium-request quota: **300/mo (Pro)**, **1500/mo (Business)**. `loginInstructions()` must mention tier + quota impact.
- AGENTS.md auto-loaded: cascade checks `AGENTS.md` at repo root, then `.github/copilot-instructions.md`. Harness must generate `AGENTS.md` from CLAUDE.md + MEMORY contents at spawn time (analogous to how CLAUDE.md is auto-loaded for Claude Code).
- Windows: binary ships as `copilot.cmd` — apply same `.cmd` retry guard used in `flushEditorBuffers` for `code.cmd`.
- Instruction string: `"Install GitHub Copilot CLI (standalone, public preview). Run 'copilot auth login' to authenticate (saves to ~/.copilot/). Verify with 'copilot --version'. Requires active Copilot subscription (Pro: 300 premium req/mo; Business: 1500/mo). DO NOT use 'gh copilot' — that is the legacy extension."`

### gemini

- Probe: `gemini --version`
- Auth: `GEMINI_API_KEY` env var (preferred for headless) OR `gemini auth` interactive (Google account, OAuth)
- Instruction string: `"Set GEMINI_API_KEY in env (https://aistudio.google.com/apikey), or run 'gemini auth' once interactively. Verify with 'gemini --version'."`

---

## 8. Per-provider usage instructions (README-bound)

To be copied into `README.md` under a new "Provider Selection" section in phase-2 impl. Captured here so impl agent has exact text.

### Switching providers

1. Edit `global-config.json` → set `"provider": "<id>"` where id ∈ `claude-code | github-copilot | gemini`.
2. Run `node Agent_Orchestrator/run-agent.js --probe` to verify auth + binary present.
3. On failure, harness prints provider's `loginInstructions()` and exits non-zero.

### Per-provider operational notes

- **claude-code:** full feature set. No config changes required from current setup.
- **github-copilot:** Uses standalone `copilot` CLI (NOT `gh copilot`). Headless invocation: `copilot -p "<prompt>" --allow-all-tools --mcp-config <path>`. MCP and tool-use supported. Model selectable via `/model` or `--model` flag (claude-sonnet-4.5, gpt-5, etc.). No sub-agents, no skills runtime, no plan-mode, no auto-resume, no stream-json. Output structured via `--log-dir` JSONL. Premium-request quota applies (Pro: 300/mo; Business: 1500/mo) — quota exhaustion emits `error_quota`. AGENTS.md auto-generated from CLAUDE.md+MEMORY at spawn.
- **gemini:** one-shot JSON. MCP works via `--mcp-config`. `--yolo` is mandatory for headless; harness sets it automatically. Sub-agent emulation uses `responseSchema` for structured returns (pending `[NEEDS-DECISION] #3`).

### Alternative workflows for unsupported surfaces

| Surface                           | claude-code                       | github-copilot fallback                                                                        | gemini fallback                                |
| --------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Plan mode                         | native `EnterPlanMode`          | two-pass prompt: explicit `<plan>` tags → harness pause → coding pass                      | same two-pass as Copilot                       |
| Worktrees                         | `Agent({isolation:'worktree'})` | provider-agnostic — harness performs `git worktree add` then spawns provider in new cwd     | same as Copilot                                |
| MCP `ToolSearch`                | native deferred-tool fetch        | harness inlines tool catalog into system prompt at spawn; no deferred fetch                    | inline catalog; deferred fetch unsupported     |
| Skills                            | `Skill` tool + auto-discovery   | inline selected SKILL.md bodies into system prompt (size cap 8 KB)                             | same as Copilot                                |
| Sub-agents (`Explore`/`Plan`) | recursive `claude` spawn        | harness-level fan-out via `parallel-broker.js` calling `provider.spawn()` sequentially     | same + optional `responseSchema` enforcement |
| Auto-resume                       | `claude --resume`               | hard-disabled,`[WARN]` printed                                                               | hard-disabled,`[WARN]` printed               |
| Hooks                             | settings.json `PreToolUse` etc. | harness wraps `provider.spawn()` with pre/post callbacks from new `harness/hooks.json`     | same as Copilot                                |
| Permission mode                   | `--permission-mode`             | n/a — Copilot has no permission model; harness enforces allow/deny by pre-scanning tool calls | `--yolo` always on; harness enforces         |

Every fallback emits a runtime `[WARN]` on first invocation so users are not surprised by silent behavior changes.

---

## 9. README limitations matrix (verbatim copy target)

Insert as `## Provider Limitations` section in `README.md` phase-2:

| Feature               | claude-code | github-copilot                                                     | gemini                         |
| --------------------- | ----------- | ------------------------------------------------------------------ | ------------------------------ |
| Streaming JSON events | ✓          | ✗                                                                 | ✗                             |
| MCP tools             | ✓          | ✓ (`--mcp-config` + `/mcp` slash-cmd)                         | ✓ (experimental)              |
| Sub-agents            | ✓          | emulated                                                           | emulated                       |
| Skills runtime        | ✓          | inlined                                                            | inlined                        |
| Plan mode             | ✓          | two-pass                                                           | two-pass                       |
| Worktrees             | ✓          | ✓                                                                 | ✓                             |
| Hooks                 | ✓          | harness-emulated                                                   | harness-emulated               |
| Auto-resume           | ✓          | ✗                                                                 | ✗                             |
| Permission mode       | ✓          | harness-enforced                                                   | yolo + harness-enforced        |
| Token + cache stats   | ✓          | ✗                                                                 | partial (no cache write count) |
| Model choice          | ✓          | ✓ (`/model` cmd or `--model`; claude-sonnet-4.5, gpt-5, etc.) | ✓                             |
| Session resume        | ✓          | ✗                                                                 | ✗                             |

---

## 10. Regression test plan (deferred to phase-2 impl)

No executable code changed this round, so no tests added now. Phase-2 impl PR MUST include at minimum the following regression tests (one per user-prompt requirement bullet):

1. **Provider config validation** — `tests/provider-config.test.js`: asserts `config-utils.load()` rejects unknown `provider` value; asserts default is `claude-code`; asserts per-provider override file merges after global, before topic.
2. **Folder rename safety** — `tests/folder-rename.test.js`: greps repo for literal `Claude_Code_Harness` outside of archive/history files; asserts no stale refs after rename commit.
3. **Login probe + instruction string** — `tests/provider-login.test.js`: for each provider, mock probe failure and assert `loginInstructions()` string contains the documented setup steps (URL + command).
4. **README limitations matrix presence** — `tests/readme-limits.test.js`: asserts `README.md` contains the `## Provider Limitations` heading and a row per provider × feature listed in §9.
5. **Per-provider usage + runtime enforcement** — `tests/provider-feature-gate.test.js`: for every `supportsFeature(name)` returning false, asserts the corresponding call site emits a `[WARN] ... unsupported under provider <id>` log and degrades (no silent no-op, no throw on unsupported feature).

Tests are enumerated here to satisfy the assessment's regression-test mandate while keeping this round design-only.

---

## 11. Acceptance criteria for design sign-off

- Catalog covers all 16 surfaces (✓ above).
- Every surface has a Copilot + Gemini mapping or explicit fallback (✓).
- Config strategy preserves backward compat (existing `global-config.json` works with `provider` defaulting to `claude-code`) (✓).
- Every `[NEEDS-DECISION]` flagged for next round (✓ — 7 items).
- Phase-2 rename audit lists every file touching `Claude_Code_Harness` literal (✓ — completed; archive/history files retained intentionally).

---

## 12. Normalized JSONL Event Envelope Spec (Addendum — locked before P1)

> **Status: LOCKED.** P1 `streamParser` implementations MUST emit exactly these shapes. Do not add new top-level fields without updating this spec first.

### 12.1 Envelope schema

Every normalized event is a single-line JSON object written to the agent JSONL transcript:

```ts
{
  type:    string,   // one of the six event types below — REQUIRED
  ts:      number,   // Unix epoch milliseconds — REQUIRED on all events
  role?:   string,   // "assistant" | "tool" — present on assistant_text, tool_call, tool_result
  content: any,      // type-specific payload — see §12.2
  meta?:   object    // optional provider-specific extras; consumers MUST ignore unknown keys
}
```

Rules:

- `ts` is always present and always a number (never null/omitted).
- `role` is omitted on `usage`, `error`, and `done`.
- `role` values: `"assistant"` (model-generated text/tool calls) and `"tool"` (tool results). No other values are valid in current event types.
- `meta` is a free bag for provider raw data (e.g. model id, session id, turn count). Downstream consumers MUST treat unknown meta keys as advisory — never gate logic on them.
- No other top-level keys. Extra fields from the raw provider stream belong inside `meta`.

### 12.2 Event types and `content` payloads

#### `assistant_text`

Text token(s) from the model.

```jsonc
{
  "type": "assistant_text",
  "ts": 1700000000000,
  "role": "assistant",
  "content": { "text": "Here is the plan..." },
  "meta": { "model": "claude-sonnet-4-6" }
}
```

| Field            | Type   | Notes                                                                                     |
| ---------------- | ------ | ----------------------------------------------------------------------------------------- |
| `content.text` | string | Full text of the assistant turn (or incremental chunk if streaming). May be empty string. |

#### `tool_call`

The model is requesting a tool invocation.

```jsonc
{
  "type": "tool_call",
  "ts": 1700000000001,
  "role": "assistant",
  "content": {
    "id": "toolu_01abc",
    "name": "Read",
    "input": { "file_path": "/some/file.txt" }
  }
}
```

| Field             | Type   | Notes                                                       |
| ----------------- | ------ | ----------------------------------------------------------- |
| `content.id`    | string | Unique call ID; matched by `tool_result.content.call_id`. |
| `content.name`  | string | Tool name exactly as declared (e.g.`"Read"`, `"Bash"`). |
| `content.input` | object | Parsed JSON arguments.                                      |

#### `tool_result`

Harness or provider returning a tool's output to the model.

```jsonc
{
  "type": "tool_result",
  "ts": 1700000000002,
  "role": "tool",
  "content": {
    "call_id": "toolu_01abc",
    "output": "line 1\nline 2",
    "is_error": false
  }
}
```

| Field                | Type   | Notes                                                                  |
| -------------------- | ------ | ---------------------------------------------------------------------- |
| `content.call_id`  | string | Matches `tool_call.content.id`.                                      |
| `content.output`   | string | Stringified result (truncate at 64 KB; append `[TRUNCATED]` if cut). |
| `content.is_error` | bool   | `true` if the tool returned an error status.                         |

#### `usage`

Token / cost accounting for the turn.

```jsonc
{
  "type": "usage",
  "ts": 1700000000010,
  "content": {
    "input_tokens": 12000,
    "output_tokens": 800,
    "cache_read_tokens": 9000,
    "cache_write_tokens": 3000,
    "cost_usd": 0.0142
  }
}
```

| Field                          | Type          | Notes                                                            |
| ------------------------------ | ------------- | ---------------------------------------------------------------- |
| `content.input_tokens`       | number\| null | Prompt tokens billed. null if provider does not expose.          |
| `content.output_tokens`      | number\| null | Completion tokens billed. null if provider does not expose.      |
| `content.cache_read_tokens`  | number\| null | Tokens served from cache. null if unavailable (Gemini, Copilot). |
| `content.cache_write_tokens` | number\| null | Tokens written to cache. null if unavailable.                    |
| `content.cost_usd`           | number\| null | Cost in USD. null if provider does not expose (Copilot).         |

Usage event is emitted **once per agent run**, immediately before `done`.

#### `error`

A recoverable or terminal error.

```jsonc
{
  "type": "error",
  "ts": 1700000000020,
  "content": {
    "code": "error_max_turns",
    "message": "Exceeded maximum turn limit",
    "recoverable": true
  },
  "meta": { "raw_subtype": "error_max_turns" }
}
```

| Field                   | Type   | Notes                                                              |
| ----------------------- | ------ | ------------------------------------------------------------------ |
| `content.code`        | string | Normalized error code — see §12.3.                               |
| `content.message`     | string | Human-readable description.                                        |
| `content.recoverable` | bool   | `true` = auto-resume may help; `false` = fatal, stop pipeline. |

#### `done`

Signals the run completed (success or after a terminal error).

```jsonc
{
  "type": "done",
  "ts": 1700000000025,
  "content": {
    "exit_code": 0,
    "session_id": "sess_01xyz"
  },
  "meta": { "num_turns": 7 }
}
```

| Field                  | Type          | Notes                                               |
| ---------------------- | ------------- | --------------------------------------------------- |
| `content.exit_code`  | number        | 0 = success; non-zero = failure.                    |
| `content.session_id` | string\| null | Provider session/resume token; null if unsupported. |

### 12.3 Normalized error codes

| Normalized `code`   | Claude raw source                         | Copilot                                                                                                                                                                                                                                                                                | Gemini                               |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `error_max_turns`   | `result.subtype === "error_max_turns"`  | n/a                                                                                                                                                                                                                                                                                    | n/a                                  |
| `error_token_limit` | `result.subtype === "error_max_tokens"` | n/a                                                                                                                                                                                                                                                                                    | `RESOURCE_EXHAUSTED` in stderr     |
| `error_auth`        | non-zero exit + auth pattern in stderr    | non-zero exit +`401` in output                                                                                                                                                                                                                                                       | non-zero exit +`API key not valid` |
| `error_spawn`       | process failed to start (ENOENT etc.)     | same                                                                                                                                                                                                                                                                                   | same                                 |
| `error_parse`       | stdout not valid JSONL                    | n/a (no stream)                                                                                                                                                                                                                                                                        | malformed `--output-format json`   |
| `error_quota`       | n/a                                       | quota-exhaustion response (premium-request limit reached; Pro 300/mo, Business 1500/mo);`[NEEDS-VERIFICATION]` — `x-ratelimit-*` header capture in `meta` assumes headers appear in `--log-dir` JSONL output; HTTP response headers may not be surfaced by the standalone CLI | n/a                                  |
| `error_unknown`     | any other non-zero exit                   | any other non-zero exit                                                                                                                                                                                                                                                                | any other non-zero exit              |

### 12.4 Claude `--output-format=stream-json` → normalized mapping

| Claude stream-json event                                                                                   | Condition                 | Normalized output                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `{"type":"system","subtype":"init","model":"..."}`                                                       | first line                | no event emitted; model stored in run state for `meta.model` on subsequent events   |
| `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}],"usage":{...}}}`                | text block in content     | `assistant_text` with `content.text`; usage stored but not emitted yet            |
| `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"...","name":"...","input":{...}}]}}` | tool_use block in content | `tool_call` with `content.{id, name, input}`                                      |
| `{"type":"tool_result","tool_use_id":"...","content":[{"type":"text","text":"..."}],"is_error":false}`   | tool result line          | `tool_result` with `content.{call_id: tool_use_id, output: text, is_error}`       |
| `{"type":"result","subtype":"success","cost_usd":0.01,"usage":{...},"session_id":"...","num_turns":3}`   | success result            | emit `usage` then `done{exit_code:0, session_id}`                                 |
| `{"type":"result","subtype":"error_max_turns",...}`                                                      | turn-limit error          | emit `error{code:"error_max_turns", recoverable:true}` then `done{exit_code:1}`   |
| `{"type":"result","subtype":"error_max_tokens",...}`                                                     | token-limit error         | emit `error{code:"error_token_limit", recoverable:true}` then `done{exit_code:1}` |
| any other non-zero exit / unparseable line                                                                 | process died or bad JSON  | emit `error{code:"error_spawn"                                                        |

Usage fields mapping — source is the **final `result` event only** (`result.usage` + `result.cost_usd`). Claude's `stream-json` also emits `message.usage` on every `assistant` turn; `streamParser` MUST NOT sum those per-turn blocks — discard them and use only the terminal `result.usage`. This avoids double-counting multi-turn sessions.

| Normalized field       | Claude source field                          |
| ---------------------- | -------------------------------------------- |
| `input_tokens`       | `result.usage.input_tokens`                |
| `output_tokens`      | `result.usage.output_tokens`               |
| `cache_read_tokens`  | `result.usage.cache_read_input_tokens`     |
| `cache_write_tokens` | `result.usage.cache_creation_input_tokens` |
| `cost_usd`           | `result.cost_usd`                          |

### 12.5 Copilot + Gemini synthetic mapping (summary)

**Copilot** (standalone `copilot` CLI — `--log-dir` JSONL, not stdout blob):

> **`[NEEDS-VERIFICATION]`** All specifics below (`-p` flag, `--log-dir` JSONL format, event `type` field names, auth path `~/.copilot/`) are based on planning-agent assumptions about a public-preview tool that launched Oct 2025 (after the assistant knowledge cutoff of Aug 2025). Probe `copilot --help` and inspect a sample `--log-dir` run before coding against these assumptions.

Invoke headless as `copilot -p "<prompt>" --allow-all-tools [--mcp-config <path>] [--model <model>] --log-dir <tmpdir>`. Do NOT use `gh copilot`; that is the legacy extension.

1. After process exits, read JSONL log files from `--log-dir`. Each line is a structured event. Parse entries by `type` field:
   - Text response entries → emit `assistant_text{content.text}`.
   - Tool-call entries → emit `tool_call{content.{id, name, input}}`.
   - Tool-result entries → emit `tool_result{content.{call_id, output, is_error}}`.
   - Usage/token entries → accumulate into `usage` event (fields: `input_tokens`, `output_tokens`, `cache_read_tokens: null`, `cache_write_tokens: null`, `cost_usd: null`). If `x-ratelimit-*` values appear in log, capture in `meta`.
   - Quota-exhaustion response (premium-request limit) → emit `error{code:"error_quota", recoverable:false}`; capture `x-ratelimit-*` in `meta` if present.
2. Emit `usage` (token fields from log or all `null` if absent).
3. Emit `done{exit_code: <process exit>, session_id: null}`.

**Gemini** (`--output-format json`, one-shot):

1. Parse JSON blob. Emit `assistant_text` from `response` field.
2. If `toolCalls[]` present, emit one `tool_call` per entry, then `tool_result` per result.
3. Map `usageMetadata`: `promptTokenCount` → `input_tokens`, `candidatesTokenCount` → `output_tokens`, `cachedContentTokenCount` → `cache_read_tokens`, `cache_write_tokens: null` (not exposed).
4. Emit `usage`, then `done`.

---

## 13. Workspace Enterprise Auth Reality Check

The `gemini` provider name covers multiple distinct auth surfaces with different capabilities and access paths. Harness implementers MUST understand these before wiring `loginInstructions()` or `probe()`.

### Auth surface 1 — AI Studio API key (`GEMINI_API_KEY`)

- **Mechanism**: API key issued at [aistudio.google.com](https://aistudio.google.com/apikey).
- **Usage**: Set `GEMINI_API_KEY` env var before spawning `gemini` CLI; the CLI picks it up automatically.
- **Provider**: `gemini` (uses `@google/gemini-cli` with `GEMINI_API_KEY`).
- **Harness detection**: `process.env.GEMINI_API_KEY` non-empty.
- **Limitations**: Free tier rate limits apply. Not suitable for regulated/enterprise data (data may be used for model improvement).

### Auth surface 2 — Google Workspace Code Assist OAuth

- **Mechanism**: Google Workspace Enterprise subscription; user authenticates via `gemini auth` (browser OAuth flow using corporate Google account).
- **Usage**: No API key; OAuth credentials cached locally after `gemini auth` runs once.
- **Provider**: `gemini` (same `@google/gemini-cli`; the CLI selects Code Assist quota if `GEMINI_API_KEY` is absent and the authenticated account has an Enterprise subscription).
- **Harness detection**: `GEMINI_API_KEY` absent + probe `gemini --version` succeeds (assume user ran `gemini auth`).
- **Limitations**: Subject to Workspace admin policy. Higher quotas than AI Studio free tier. No direct API key to inspect.

### Auth surface 3 — Vertex AI ADC (`GOOGLE_CLOUD_PROJECT` + Application Default Credentials)

- **Mechanism**: Google Cloud project with Vertex AI API enabled; credentials via `gcloud auth application-default login` (ADC).
- **Usage**: Set `GOOGLE_CLOUD_PROJECT` env var; ADC credentials in `~/.config/gcloud/application_default_credentials.json`.
- **Provider**: `gemini-vertex` (separate provider module — NOT the `gemini` AI Studio path). `[NEEDS-VERIFICATION]` — Vertex invocation may require `--vertex` flag on `@google/gemini-cli` or a completely different binary.
- **Harness detection**: `process.env.GOOGLE_CLOUD_PROJECT` non-empty; optionally confirm ADC file exists.
- **Limitations**: Billed per-token to GCP project. Requires `roles/aiplatform.user` IAM role. Data stays within GCP boundary (enterprise data compliance).

### Auth surface 4 — In-product side-panel (no API access)

- **Mechanism**: Gemini embedded in Google Workspace apps (Docs, Gmail, etc.) or in a browser at gemini.google.com.
- **Usage**: Browser-only; no CLI, no API, no harness integration possible.
- **Provider**: N/A — harness cannot drive this surface at all.
- **Harness detection**: Not applicable; document in `loginInstructions()` as an out-of-scope surface if user asks.

### Runtime detection in `gemini.js`

`probe()` and `spawn()` in `gemini.js` detect which surface to use in this priority order:

1. `GEMINI_API_KEY` set → AI Studio path (surface 1). Spawn `gemini -p <prompt> --yolo ...` directly.
2. `GEMINI_API_KEY` unset + `gemini --version` succeeds → Code Assist OAuth path (surface 2). Same spawn; emit `[INFO]` that Code Assist quota applies.
3. `GOOGLE_CLOUD_PROJECT` set → Vertex AI path (surface 3). Emit `[WARN]` directing user to `"provider": "gemini-vertex"` in `global-config.json` and exit probe as `false` (wrong provider for this surface).

`gemini-vertex.js` handles surface 3 exclusively. Its `probe()` checks `GOOGLE_CLOUD_PROJECT` + ADC file presence.

### Summary table

| Surface               | Provider id       | Env trigger                | Works headless             | Harness support      |
| --------------------- | ----------------- | -------------------------- | -------------------------- | -------------------- |
| AI Studio API key     | `gemini`        | `GEMINI_API_KEY`         | ✓                         | ✓                   |
| Code Assist OAuth     | `gemini`        | no key,`gemini auth` ran | ✓ (after auth)            | ✓                   |
| Vertex AI ADC         | `gemini-vertex` | `GOOGLE_CLOUD_PROJECT`   | ✓ (after `gcloud auth`) | ✓ (separate module) |
| In-product side-panel | —                | browser only               | ✗                         | ✗ not supported     |
