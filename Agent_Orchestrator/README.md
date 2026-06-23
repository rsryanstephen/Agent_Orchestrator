# Agent Orchestrator

A local agent orchestration system built on top of the Claude Code CLI. Each **topic** gets a **single markdown history file** that holds every user prompt and every agent response (planning, coding, assessment, remediation) in chronological order. Agents are stateless `claude --print` invocations — context is reconstructed from that one file on every run.

---

## Quick Start (1-page summary)

**What it does.** One markdown history file per topic captures every prompt and every agent response (planning → coding → assessment → fix). Agents are stateless `claude --print` calls; the harness reconstructs context from that file on each run and appends the new response.

**On this page:** [Prerequisites](#prerequisites) · [Installation](#installation) · [Shell Functions](#shell-functions-bash--zsh) · [Running Agents](#running-agents) · [Topic Management](#topic-management) · [Prompt Queue](#prompt-queue-auto-advance-multiple-prompts) · [Memory Management](#memory-management) · [Typical Workflow](#typical-workflow) · [Concepts](#concepts) · [Intra-topic parallelism](#intra-topic-parallelism-auto-fan-out-within-a-single-topic) · [Cross-topic parallelism](#cross-topic-parallelism-hrun-with-multiple-tokens) · [Clarifying-questions pause](#clarifying-questions-pause-auto-answer-clarifying-questions-false) · [Background tasks](#background-tasks) · [Interrupted runs / auto-resume](#interrupted-runs-continue-and-auto-resume-on-token-limit) · [Configuration](#configuration-global-configjson) · [Provider Selection](#provider-selection) · [Provider Limitations](#provider-limitations) · [Troubleshooting](#troubleshooting)

**Where the aliases go.** Keep **one** copy of `Agent_Orchestrator/` anywhere, set `harness-root` in `global-config.json` to its absolute inner-dir path, then install. The canonical shell functions live in [`shell-functions.txt`](shell-functions.txt); the installer substitutes `{{HARNESS_ROOT}}` with that absolute path and writes the block between managed markers in your `~/.bashrc` / `~/.zshrc`:

```bash
node /abs/path/Agent_Orchestrator/src/install-shell-functions.js   # writes absolute-path block, idempotent
source ~/.bashrc                                                   # or ~/.zshrc
```

The installed functions use **absolute paths** — run `hrun`, `hstartt`, etc. from **any** repo; no per-repo copy needed. If `harness-root` is empty the installer self-detects from the script location.

**How to run (minimal walkthrough):**

```bash
hstartt my-feature 5     # 1. create topic "my-feature" with id 5
                         # 2. open topic_files/my-feature/my-feature.md and write your task
                         #    under the existing "## User Prompt" header
hrun 5-all               # 3. run planning → coding → assessment → fix on topic 5
```

Read the appended responses in the history file, then queue or type the next prompt.

---

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — preferred provider, installed and authenticated (`claude` on your PATH). Not mandatory; other providers in `src/lib/providers/` are also supported.
- Node.js 18+

---

## Installation

The harness is repo-agnostic and lives as a **single instance** that serves every repo. To set it up:

1. **Keep one copy of `Agent_Orchestrator/`** anywhere on disk (no need to copy it per repo).
2. **Set `harness-root` in `global-config.json`** to the absolute path of the inner `Agent_Orchestrator` directory (the one holding `src/` and `shell-functions.txt`). On Windows use forward slashes, e.g. `C:/Users/you/Repos/Agent_Orchestrator/Agent_Orchestrator`. Leave it empty to let the installer self-detect from its own location.
3. **Run `node <harness-root>/src/install-shell-functions.js`** — the installer substitutes `{{HARNESS_ROOT}}` and appends the `h*` shell functions (with absolute paths) to your rc file. Re-run with `--force` to refresh a stale block (e.g. one from an older relative-path version).
4. **Open any repo** and use `hrun`, `hstartt`, etc. — they resolve harness bookkeeping against `harness-root` and operate on your current working directory.

---

## Shell Functions (bash / zsh)

Aliases do not support positional parameters in bash/zsh — use **functions** instead. The canonical source is [`shell-functions.txt`](shell-functions.txt).

**Quick install:** run `node Agent_Orchestrator/src/install-shell-functions.js`. It detects whether any of the harness functions (`hstartt`, `hrun`, etc.) are already defined in your `~/.bashrc` / `~/.zshrc` — if not, it appends the block from `shell-functions.txt` between managed markers. Idempotent: re-running does nothing unless you pass `--force` (which also removes any pre-existing unmanaged definitions, **including legacy `runc`/`runpar`/etc. helpers from older harness versions**, before installing the managed block). If the rc file is read-only it prints a permission error — it does **not** auto-elevate; you must re-run manually from an elevated shell (Run as Administrator on Windows, or prefix with `sudo` on macOS/Linux). After install, open a new shell or `source ~/.bashrc` / `source ~/.zshrc`. **Note:** the installed functions use **absolute paths** (substituted from `harness-root`) — they work from any repo's working directory.

Or add them manually (the block below may drift from [`shell-functions.txt`](shell-functions.txt) — treat `shell-functions.txt` as the canonical source):

> **Git Bash on Windows:** these functions use `\node` (escaped) rather than `node`. On Git Bash for Windows `node` is aliased to `winpty node.exe`, which wraps the child process in a pseudo-terminal that (a) causes bash background jobs (`&`) to be `Stopped` immediately on SIGTTOU, and (b) breaks `run-parallel.js`'s prefixed-stream output. The leading backslash bypasses the alias and runs the real `node.exe` directly. On macOS/Linux the `\` is harmless — it simply runs `node`.

Replace `{{HARNESS_ROOT}}` with the absolute path of your harness inner directory (forward slashes on Windows):

```bash
# Topic management
hstartt()    { \node {{HARNESS_ROOT}}/src/start-topic.js "$1" "$2"; }   # hstartt <topic> [id]
hsett()      { \node {{HARNESS_ROOT}}/src/set-topic.js "$1" "$2"; }     # hsett <topic> <id>
hrentopic()  { \node {{HARNESS_ROOT}}/src/rename-topic.js "$1" "$2"; }  # hrentopic <topic|id> <new-name>
hrmtopic()   { \node {{HARNESS_ROOT}}/src/remove-topic.js "$1"; }       # hrmtopic <topic|id|all>

# Unified runner — single command for single-topic and parallel runs.
# Usage: hrun [[<id|topic>-]<cmd> ...]
#   hrun 1-c          # topic 1, coding (explicit pipeline)
#   hrun 2-caf        # topic 2, code-assess-fix
#   hrun caf          # last-touched topic, code-assess-fix
#   hrun 1-c 2-caf    # topic 1 coding AND topic 2 code-assess-fix in parallel
#   hrun 3            # topic id 3 — pipeline from the `## User Prompt` header / promptQueue.defaultPipeline
#   hrun claude_harness  # named topic — pipeline from header / default
#   hrun              # last-touched topic — pipeline from header / default
# Shorthand: p|c|a|f|af|pc|caf|all|pcaf|cont
hrun()       { \node {{HARNESS_ROOT}}/src/run-parallel.js "$@"; }

hresume()    { \node {{HARNESS_ROOT}}/src/auto-resume.js "$@"; }  # hresume [topic|id|all] — manually trigger auto-resume for topics in the wake queue (mostly for testing — normally triggered automatically by the OS scheduler at the token-limit reset time)

# Memory (single-file-per-topic — no role argument)
hclear()     { \node {{HARNESS_ROOT}}/src/clear-memory.js "$@"; }    # hclear [topic|id|all]
hscrubmem()  { \node {{HARNESS_ROOT}}/src/scrub-compressed-memory.js "$@"; } # hscrubmem [topic|id|all] — strip stale ## Compressed Memory sections

# Prompt-queue maintenance
hqregen()    { \node {{HARNESS_ROOT}}/src/regenerate-queue.js "$@"; } # hqregen [topic|id|all] — destructively wipe and re-seed prompt-queue.md

# Misc
hupdate-models() { \node {{HARNESS_ROOT}}/src/update-models-reference.js; }  # hupdate-models
hfetch-models()  { \node {{HARNESS_ROOT}}/src/fetch-models.js; }             # hfetch-models — force-refresh model catalog cache
hprobe()         { \node {{HARNESS_ROOT}}/src/run-agent.js --probe; }  # hprobe — checks provider auth

# Harness install (idempotent — adds these functions to your rc file if missing)
# \node {{HARNESS_ROOT}}/src/install-shell-functions.js "$@"; [--force]
```

Usage with shell functions:

```bash
hstartt my-feature 5
hrun 5-c              # coding for topic 5
hrun 5-all            # full planning → coding → assessment → fix pipeline for topic 5
hrun caf              # code-assess-fix on the last-touched topic
hrun 1-c 2-caf 3-p    # parallel: topic 1 coding, topic 2 code-assess-fix, topic 3 planning
hrun 1-cont           # resume topic 1 from its last-failed phase
hclear 5              # reset topic 5's history file
hclear                # reset every topic's history file
hrmtopic my-feature
```

`hrun` accepts one or more `<id>-<cmd>` (or bare `<cmd>`) tokens. With a single token, the child is spawned with `stdio: 'inherit'` so interactive prompts (e.g. the clarifying-questions pause) work normally. With multiple tokens, each job is spawned concurrently as a Node child process with line-prefixed output.

---

## Running Agents

All agent commands follow this pattern:

```bash
node Agent_Orchestrator/src/run-agent.js <topic-name|id> <command>
```

### Single-agent commands

All phases read from and append to the same single history file (`<topic-files-dir>/<topic>/<topic>.md`). Headers identify the agent that wrote each block.

| Command        | What it does                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `planning`   | Reads conversation context from the history file and produces an implementation plan. Appends `## Planning Agent Response`.                                                                                                                                      |
| `coding`     | Reads conversation context from the history file and executes the task. Appends `## Coding Agent Response`.                                                                                                                                                      |
| `assessment` | Reads conversation context from the history file and reviews recent changes. Appends `## Assessment Agent Response`.                                                                                                                                             |
| `fix`        | Reads the latest `## Assessment Agent Response` from the history file and fixes the code. Appends `## Coding Agent Response (Remediation)`.                                                                                                                    |
| `continue`   | Resume the last interrupted pipeline for this topic from the exact phase that failed (read from `Agent_Orchestrator/.state/<topic>.json`). Skips already-completed phases and runs the remainder of the original pipeline. Errors out if no resume state exists. |

### Pipeline commands

| Command             | Pipeline                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `assess-fix`      | `assessment` → `fix` (assess the last coding work, then apply fixes)                                            |
| `plan-code`       | `planning` → `coding` (coding agent executes the plan output)                                                   |
| `code-assess-fix` | `coding` → `assessment` → `fix`                                                                              |
| `all`             | `planning` → `coding` → `assessment` → `fix` (planning skipped if planning log has no `## User Prompt`) |

Each phase in a pipeline is independently error-gated — a failure in any phase aborts the remaining phases immediately.

> **One `## User Prompt` suffix per run.** Intermediate phases in a pipeline append only their `## <Role> Agent Response` block. The trailing `\n## User Prompt` divider is appended **only after the final phase** completes. So `hrun <id>-caf` produces one `## Coding Agent Response`, one `## Assessment Agent Response`, one `## Coding Agent Response (Remediation)`, and then a single `## User Prompt` slot ready for your next message.
>
> **Why do I see multiple response blocks under one `## User Prompt`?** Two distinct causes:
>
> 1. **Pipeline.** A single `hrun <id>-caf` / `hrun <id>-all` legitimately writes three or four agent-response blocks (coding → assessment → remediation, with planning when present) under the same `## User Prompt`. That is the expected shape.
> 2. **Intra-topic fan-out.** When the prompt or planning output decomposes into independent subtasks (see [Intra-topic parallelism](#intra-topic-parallelism-auto-fan-out-within-a-single-topic)), each parallel agent appends its own block with a `(task-N)` suffix — e.g. `## Coding Agent Response (task-1)`, `## Coding Agent Response (task-2)`, `## Assessment Agent Response (task-1)`, `## Coding Agent Response (Remediation task-1)`. That is one logical pipeline run, fanned out across N agents.
>
> **Planning sets downstream effort and model:** After the planning agent responds, it analyzes its own plan text and writes the resolved `coding` and `assessment` effort levels **and model selections** to the topic's `topic-config.json`. This gives downstream agents both a thinking budget and a model tier calibrated to the actual scope of the plan rather than the raw prompt length. Auto-selected values are reset back to `auto` after each run so the next prompt re-classifies.

### Examples

```bash
node Agent_Orchestrator/src/run-agent.js user-auth coding
node Agent_Orchestrator/src/run-agent.js 3 all
node Agent_Orchestrator/src/run-agent.js user-auth plan-code
```

---

## Topic Management

### Initialize a new topic

```bash
node Agent_Orchestrator/src/start-topic.js <topic-name> [id]
```

Creates `<topic-files-dir>/<topic>/<topic>.md` (history) and `<topic-files-dir>/<topic>/topic-config.json` (minimal scaffold containing `topic-id` and `prompt-file`), then registers the topic in `global-config.json` under `topic-ids`. The numeric ID is optional — one is auto-assigned if omitted.

```bash
node Agent_Orchestrator/src/start-topic.js user-auth 3
node Agent_Orchestrator/src/start-topic.js user-auth        # auto-assigns next available ID
```

### Reassign a numeric ID

```bash
node Agent_Orchestrator/src/set-topic.js <topic-name> <id>
```

Points an existing ID at a different topic. Cleans up any stale ID entries that were previously pointing to the same topic.

### Rename a topic

```bash
node Agent_Orchestrator/src/rename-topic.js <topic-name|id> <new-name>
```

Renames the topic directory and its history file, and updates `global-config.json` (`topic-ids` references) in one operation.

### Update models reference table

Regenerates `Agent_Orchestrator/models-reference.md` with the current known models and their valid effort levels. Run this after updating the model constants in `run-agent.js`.

```bash
node Agent_Orchestrator/src/update-models-reference.js
```

### Remove a topic

```bash
node Agent_Orchestrator/src/remove-topic.js <topic-name|id|all>
```

Permanently deletes the topic's history directory and removes it from `topic-ids` in `global-config.json`.

```bash
node Agent_Orchestrator/src/remove-topic.js user-auth   # remove one topic
node Agent_Orchestrator/src/remove-topic.js all         # wipe everything — resets `topic-ids` to {}
```

---

## Per-prompt pipeline via `## User Prompt` header (preferred)

You can pick the pipeline (and model/provider) for a single run directly from the **first line of the latest `## User Prompt` block** in the topic history file — no `-cmd` suffix needed. This is the preferred way to vary the pipeline per prompt.

**Grammar** is IDENTICAL to the prompt-queue header (shared parser):

- Bare shorthand: `caf`, `pcaf`, `pc`, `all`, … (must match a `Shorthand:` entry in [`shell-functions.txt`](shell-functions.txt)).
- Model family / exact id / provider: `opus`, `sonnet`, `gpt-4.1`, `(model=…)`, `(provider=…)` — same tokens accepted on the queue header.
- Combine them on one line: `opus caf` → run `code-assess-fix` on Opus.

**Invoke topic-only** so the header is honoured:

```bash
hrun 3                 # topic id 3 — pipeline from the header
hrun claude_harness    # named topic — pipeline from the header
hrun                   # last-touched topic — pipeline from the header
```

**Precedence & rules:**

- An explicit CLI pipeline always wins the pipeline choice: `hrun 1-caf` runs `code-assess-fix` regardless of any header pipeline (the header's **model/provider** is still applied).
- The header's model/provider override is **always** applied for that run only (snapshot + restore, same as the queue header path).
- The header line is **stripped** from the prompt block before agents read it, so `opus caf` never leaks into the prompt content.
- No header (first non-blank line is prose) → falls back to `promptQueue.defaultPipeline` (default `all`).

**Example** (`## User Prompt` block in the history file):

```markdown
## User Prompt

opus caf
Add retry/backoff to the upload client.
```

---

## Prompt Queue (auto-advance multiple prompts)

Each topic dir gets a `prompt-queue.md` (seeded by `start-topic.js`) where you can stack follow-up prompts. When the current pipeline finishes, the harness pops the head block, injects it under `## User Prompt` in the topic history file, and dispatches the next pipeline automatically.

**File location:** `<topic-files-dir>/<topic>/prompt-queue.md`

**Format:**

- Blocks are separated by a line containing only `---`.
- The first non-blank line of each block is an optional **pipeline header** in one of two forms:
  - `Pipeline: caf` — explicit `Pipeline:` prefix
  - `pcaf` — bare shorthand on its own line (must match an entry in [`shell-functions.txt`](shell-functions.txt)'s `Shorthand:` line)
- Missing header → uses `promptQueue.defaultPipeline` (default `all`).

**Example:**

```markdown
Pipeline: caf
Add the foo bar feature to the widget service.

---

pcaf
Then refactor the widget cache to use LRU.
```

**Hold marker (skip without removing):**

Tag any block with a hold marker to keep it parked in the file while the harness dequeues the next unheld block instead. Useful for stacking drafts you are not ready to dispatch.

- Inline form — append `(hold)` to the pipeline header: `Pipeline: caf (hold)` or `pcaf (hold)`.
- Body form — put `hold` (optionally wrapped: `(hold)`, `[hold]`, `<HOLD>`) as the **first non-blank line** of the block. Mid-body matches are ignored. The hold line may sit directly under a header OR stand alone above a header-less prompt body (no `Pipeline:` / shorthand line required).

Held blocks are skipped during dequeue and left in their original position; the first unheld block is popped instead. If every block in the queue is held, the harness logs `all-held` and dispatches nothing. Hold matching is case-insensitive.

> **Inspection note:** when a standalone `(hold)` line sits above a `Pipeline:` / shorthand header, the parser treats `(hold)` itself as the first non-blank line, so the header below it is swallowed into the body and `block.pipeline` parses as `null` while the block remains held. The actual pipeline is resolved (from the header or from `promptQueue.defaultPipeline`) once you delete the standalone `(hold)` line and the block becomes dispatchable. This is cosmetic only for tools that introspect the queue — dispatch behaviour is unaffected.

```markdown
Pipeline: caf (hold)
Draft prompt parked for later — will be skipped by dequeue.

---

pcaf
hold
Body-form hold under a header — still skipped, body content preserved on the file.

---

(hold)

Standalone hold above a header-less prompt — also skipped. Pipeline falls back to `promptQueue.defaultPipeline` when this block is eventually unheld.

---

caf
This block dispatches next because the three above are held.
```

**Config (in `global-config.json` or per-topic `topic-config.json`):**

- `promptQueue.autoAdvance` (default `true`) — when `false`, the harness logs `prompt-queue: N pending block(s)` and waits. Type `:queue-next` (or `:qn`) at the reply prompt to dispatch the head block manually. Note: the on-disk key really is dotted camelCase, not kebab-case — see [Configuration](#configuration-global-configjson).
- `promptQueue.defaultPipeline` (default `"all"`) — shorthand used when a block has no header.

**Safety:**

- An unknown shorthand in the head block leaves the queue **untouched** and surfaces a warning, so a typo never silently drops a prompt.
- Mutations are serialised through a sibling `prompt-queue.md.lock` so an editor save mid-dequeue cannot corrupt the queue.
- Shorthand list is sourced dynamically from `shell-functions.txt` — keep both in sync. The regression tests under `Agent_Orchestrator/tests/prompt-queue.test.js` enforce this.

**Empty-prompt auto-dequeue:** running `hrun <topic>-<cmd>` with an empty user prompt (no `## User Prompt` body in the history file) causes the harness to auto-pop the first unheld block from `prompt-queue.md` and use it as the prompt. No special flag needed — this is the same code path that drains the queue after a pipeline completes.

**Recovering a desynced queue:** if the queue file gets corrupted or out-of-sync with the harness's view of it, run `hqregen [topic|id|all]` (or type `:queue-regen` / `:qregen` at the reply prompt). This is **destructive** — it removes every existing block (including any user-edited content) and writes a fresh seeded `prompt-queue.md`. Use only after confirming nothing pending matters.

---

## Memory Management

Context memory is file-based. Each run reads all `## User Prompt` and `## <Role> Agent Response` blocks back to the nearest `--- CLEAR CONTEXT ---` divider. To reset the context window without deleting history, use `clear-memory.js`.

When a history file exceeds `history-archive-threshold-lines` (default 4000), the harness rotates it: full content is copied to a sibling `*.archive-<ts>.md` file and the live history is reset to the clear marker plus a short notice. No summary is generated. To strip any stale `## Compressed Memory` blocks left over from prior harness versions, run `scrub-compressed-memory.js`.

Because the architecture uses one history file per topic, both commands take a single `<topic|id|all>` argument (no role flag).

### Clear memory (hard reset)

Appends `--- CLEAR CONTEXT ---` to the target file. All content before the marker is ignored on future runs but remains in the file for reference.

| Command                             | Clears                    |
| ----------------------------------- | ------------------------- |
| `node clear-memory.js`            | All topics                |
| `node clear-memory.js all`        | All topics                |
| `node clear-memory.js <topic\|id>` | That topic's history file |

```bash
node Agent_Orchestrator/src/clear-memory.js                      # reset every topic's history
node Agent_Orchestrator/src/clear-memory.js user-auth            # reset user-auth's history
node Agent_Orchestrator/src/clear-memory.js 3                    # reset topic ID 3's history
```

### Scrub stale Compressed Memory blocks

Older harness versions injected `## Coding Agent Response (Compressed Memory)` / `## Compressed Memory` sections into history files. That code path has been removed. `scrub-compressed-memory.js` strips any of those legacy sections from a topic's history file (and creates a `.bak` next to each touched file).

| Command                                        | Scrubs                    |
| ---------------------------------------------- | ------------------------- |
| `node scrub-compressed-memory.js`            | All topics                |
| `node scrub-compressed-memory.js all`        | All topics                |
| `node scrub-compressed-memory.js <topic\|id>` | That topic's history file |

```bash
node Agent_Orchestrator/src/scrub-compressed-memory.js           # scrub every topic
node Agent_Orchestrator/src/scrub-compressed-memory.js user-auth # scrub user-auth
```

### Why the `handoff` skill is not wired into agent-to-agent passing

The `handoff` skill (under `Agent_Orchestrator/skills/handoff/`) compacts a conversation for a **fresh human session**. We considered invoking it between agents (e.g. planning → coding) to shrink the context window further, but rejected it: the harness already truncates each historical agent block to `context-truncation` chars in `parseConversationContext`. Inserting an extra agent call to produce a handoff document on every pipeline run would add latency and tokens for no net reduction in downstream cost.

---

## Typical Workflow

```bash
# 1. Initialize a topic
node Agent_Orchestrator/src/start-topic.js my-feature 5

# 2. Add your task to the history file
#    Open <topic-files-dir>/my-feature/my-feature.md
#    Under the existing "## User Prompt" header, write what you want done.

# 3. Run the coding agent
node Agent_Orchestrator/src/run-agent.js 5 coding

# 4. Review the response in the history file, then run assessment
node Agent_Orchestrator/src/run-agent.js 5 assessment

# 5. Apply fixes based on assessment feedback
node Agent_Orchestrator/src/run-agent.js 5 fix

# Or run the full pipeline in one command — every phase writes into the same history file,
# with one trailing "## User Prompt" appended only after the final phase finishes.
node Agent_Orchestrator/src/run-agent.js 5 code-assess-fix
```

---

## Concepts

| Term                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Topic**                   | A named unit of work (e.g.`user-auth`, `data-dictionary`). Has one history file at `<topic-files-dir>/<topic>/<topic>.md` and a per-topic config at `<topic-files-dir>/<topic>/topic-config.json`.                                                                                                                                                                                                                                               |
| **ID**                      | A numeric shortcut for a topic (e.g.`1` → `user-auth`). Accepted anywhere a topic name is. Mapped via the global `topic-ids` object.                                                                                                                                                                                                                                                                                                              |
| **History file**            | A single markdown file per topic containing `## User Prompt` sections (you write these) interleaved with role-prefixed agent responses: `## Planning Agent Response`, `## Coding Agent Response`, `## Assessment Agent Response`, and `## Coding Agent Response (Remediation)` (when a fix follows an assessment). A pipeline appends each phase's response in order and then a single trailing `## User Prompt` at the very end of the run. |
| **Context window**          | On each run, the agent reads all prompt/response blocks back to the last `--- CLEAR CONTEXT ---` divider (or the top of the file). Historical agent responses are truncated (configurable via `context-truncation`, default 400 chars).                                                                                                                                                                                                              |
| **History write safeguard** | Only the harness appends to the history file. Each phase snapshots the file size before invoking the agent; if the agent writes to the history file directly (`Write`/`Edit`), the harness truncates back to the snapshot under a file lock and re-appends via `appendToFile`. This prevents duplicate or stray `## User Prompt` blocks from polluting parsing. Existing duplicates from prior runs are left as-is.                              |

History file layout per topic:

```
<topic-files-dir>/<topic>/
  <topic>.md            # the single history file
  topic-config.json     # per-topic config overrides (topic-id, prompt-file, optional overrides)
  prompt-queue.md       # optional queued follow-up prompts
```

Section format inside the history file (chronological, top to bottom):

```markdown
## User Prompt

<your task description here>

---

## Planning Agent Response       # only when planning ran this turn

<plan...>

---

## Coding Agent Response

<coding summary...>

---

## Assessment Agent Response     # only when assessment ran this turn

<findings...>

---

## Coding Agent Response (Remediation)   # only when a fix followed an assessment

<remediation summary...>

---

## User Prompt                    # appended exactly once, after the final phase of the run
```

Intra-topic fan-out variants suffix the role header with `(task-N)` (and `(Remediation task-N)` for the fix phase).

---

## Intra-topic parallelism (auto-fan-out within a single topic)

In addition to running **different topics** in parallel via `hrun` with multiple tokens (e.g. `hrun 1-c 2-caf`), the harness can run **multiple agents within the same topic** concurrently when the user prompt or planning output naturally decomposes into independent subtasks. This is automatic — no special command is required.

**When fan-out triggers:**

1. **Heuristic split** — when the latest `## User Prompt` in the history file contains a top-level numbered list (`1.`, `2.` …) or bulleted list (`-`, `*`, `•`), the harness assigns one coding agent per top-level item. Any preamble before the list is included with every subtask. Sub-items (indented lines) belong to their parent.
2. **Planning-driven split** — when the planning agent emits a `## Parallel Tasks` section at the end of its plan (a numbered list of self-contained subtasks), the harness uses those subtasks instead of the heuristic split. The planning system prompt now instructs the planning agent to emit this section when work is parallelisable.

**How fan-out works:**

- Each parallel coding agent receives **only its own subtask** plus the full original prompt as reference. They are explicitly briefed that sibling agents are running concurrently against the same files, so they must not duplicate sibling work.
- All parallel responses are appended to the same history file as `## Coding Agent Response (task-1)`, `## Coding Agent Response (task-2)`, etc. Concurrent writes are serialised with a per-file lock (`<file>.lock`).
- When `parallel-assessment-agents` is `true` (default), an **equal number of parallel assessment agents** are then run, one per subtask, writing `## Assessment Agent Response (task-N)`. Each assessment agent is briefed that the git diff contains changes from all N parallel coding agents, so it must not assume every change came from the agent it is assessing. When `false`, coding fans out but a **single** assessor reviews the combined diff (also briefed about the parallel context).
- Fix phase (`hrun <id>-f`, `hrun <id>-af`, `hrun <id>-caf`, `hrun <id>-all`) fans out the same way, writing `## Coding Agent Response (Remediation task-N)`. Each fix agent only sees the assessment block for its own subtask.
- Heartbeat output during a fan-out shows `[{n} coding-agents] working… tasks: [task-1, task-2, …]` (and the analogous line for assessment).

**Configuration:**

| Field                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max-parallel-agents-per-topic` | Maximum number of agents that can run concurrently within a single topic. Default `4`. Set to `1` to disable intra-topic parallelism entirely (a single agent per phase regardless of how many subtasks the prompt contains). If more subtasks are detected than the cap, the excess are dropped (only the first N are run). Independent of cross-topic concurrency via `hrun`. Legacy key `max-concurrent-agents` is still read as a fallback. |
| `parallel-assessment-agents`    | When `true` (default), parallel coding runs spawn an equal number of parallel assessment + remediation agents (one per coding task). When `false`, coding fans out but assessment + fix stay serial — a single assessor reviews the combined diff and is briefed about the parallel coding context.                                                                                                                                                |

### Cross-topic parallelism (`hrun` with multiple tokens)

`hrun` launches any number of topic+command tokens concurrently and waits for all of them to finish. Token format: `<id>-<cmd>` (explicit topic id) or `<cmd>` (uses the last-touched topic). `<cmd>` is one of `p`, `c`, `a`, `f`, `af`, `pc`, `caf`, `all`, `pcaf`, `cont`.

```bash
hrun 1-c 2-caf 3-p   # coding for topic 1, code-assess-fix for topic 2, planning for topic 3 — all at once
hrun 1-c             # single-topic — runs interactively (stdin inherited, no prefixed output)
hrun caf             # last-touched topic, code-assess-fix
```

Implemented as `Agent_Orchestrator/src/run-parallel.js`. With **one** token the child inherits stdio (clarifying-questions pause works as usual). With **multiple** tokens each job is spawned as a Node child process with `stdio: ['ignore','pipe','pipe','ipc']`, and stdout/stderr are streamed to the terminal prefixed by the token (e.g. `[1-c] ...`). The Node-child approach avoids the Git Bash + `winpty` SIGTTOU issue that caused bare `&` background jobs to immediately enter the `Stopped` state. The `ipc` channel is used by the **Parallel Clarifying-Question Queue** broker (below) to serialise clarifying-question prompts from many concurrent children through one CLI stdin.

### Parallel Clarifying-Question Queue

When `hrun` is launched with multiple tokens, `run-parallel.js` instantiates a **broker** (`Agent_Orchestrator/src/parallel-broker.js`) that owns the single CLI stdin. Each child agent stays running while it awaits clarifying-question answers — no suspension, no resume dance.

**Design rationale.** The harness is single-CLI by contract: one terminal, one keyboard. When two topics in the same shell both hit a `## Clarifying Questions` section at the same time, only one of them can usefully read stdin at a time. The broker resolves the contention deterministically.

**Flow.**

1. Each child (`run-agent.js`) detects IPC mode via `process.send && process.connected`. Instead of opening its own readline, it emits `process.send({type:'question', topic, role, questionsText})` and awaits the parent's `{type:'answer', text}`.
2. The broker maintains a **strict FIFO** `pendingQuestions` queue. The first arrival plays the existing chime and prints `[<id>-<cmd>] (<topic>) clarifying questions ready — press any key to view (queue: N)`. Subsequent arrivals while another is active emit only a one-line `{topic}: [B] queued: N pending questions` notice (no sound re-trigger, no interruption of active typing).
3. The broker waits for a single keystroke before rendering the head item with a `[<id>-<cmd>] (<topic>)` banner — e.g. `[2-caf] (claude_harness)` — then drops to cooked-mode multi-line capture using the same `:submit` / `:s` / two-blank-lines accumulator as the standalone path (shared via `reply-parser.js`).
4. On submit, the broker routes the answer back to the originating child via `child.send({type:'answer', text})`, pops the queue head, and — if anything is queued — re-prints `next clarifying questions queued — press any key to view`.

**Lifetime.** Children stay running while blocked. The broker maps each child by token; an `exit` mid-wait drains its queued question with a `[<token>] child exited while awaiting answer — dropping question` warning. `Ctrl-C` on the broker forwards `SIGTERM` to all children. Assumption: at most one outstanding question per child (planning blocks until answered) — no per-child queueing.

**Cross-shell caveat.** Running parallel topics across **separate shells** bypasses the broker entirely (each shell owns its own stdin). That's by design — no cross-shell coordination is attempted. If you need queueing, run the topics as `hrun <token-1> <token-2> ...` in one shell.

**Troubleshooting — IPC disconnect.** If a child loses its IPC channel (e.g. parent killed), the child detects the `disconnect` event and exits with code 1 (its stdin is `ignore`d under broker spawn, so a readline fallback would hang). A `process.send` throw on a still-connected channel resolves an empty reply rather than blocking. The broker side drops the queued entry on child `exit` and warns.

**Sentinel parity caveat.** The standalone readline path also recognises `:queue-next` / `:qn` sentinels for fast-forward navigation through pending file-based prompts; under the broker IPC path the queue is FIFO and broker-driven, so those sentinels are inert there — submit normally (`:submit` / `:s` / two blank lines) and the broker advances to the next queued item automatically.

Tests:

- `Agent_Orchestrator/tests/parallel-broker.test.js` — FIFO order, answer routing by token, child-exit drop + warning, sound suppression after first item, banner prefix formatting.
- `Agent_Orchestrator/tests/promptForUserReply.multiline.test.js` — extended to assert the IPC code path emits `process.send` instead of reading stdin when `process.connected` is true.

Concurrent writes to `global-config.json` (context tracking, planning effort/model propagation) are serialised via a lock file (`.global-config.lock` in `Agent_Orchestrator/`). A process that finds the lock held will retry every 100 ms and time out after 30 s. Stale locks left by crashed processes are automatically detected and removed.

### Configuring the spawned terminal

When the harness must open a new window (auto-resume after token limit, prompt-queue same-terminal fallback), the `preferred-terminal` setting controls which terminal is used:

| Value                    | Behaviour                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `"git-bash"` (default) | Opens a new Git Bash window. Requires `C:\Program Files\Git\bin\bash.exe`.            |
| `"cmd"`                | Opens a new `cmd.exe` window (`cmd /k node ...`).                                   |
| `"powershell"`         | Opens a new PowerShell window (`powershell -NoExit -Command ...`).                    |
| `"wt"`                 | Opens a new Windows Terminal tab (`wt -d <root> cmd /k node ...`).                    |
| `"none"`               | Headless detached spawn (no window, stdout/stderr go to `.state/resume-<topic>.log`). |

If the chosen terminal binary is not found, the harness logs a warning and falls back to headless spawn. In all cases stdout/stderr are also redirected to `.state/resume-<topic>.log`. Legacy key `resume-terminal` is still read as a fallback with a deprecation log.

---

## Clarifying-questions pause (`auto-answer-clarifying-questions: false`)

When the planning agent (or coding agent if planning is skipped) emits a `## Clarifying Questions` section inside its response, the harness pauses **before** the next phase runs:

- With `auto-answer-clarifying-questions: false`: the harness appends `## User Reply to Questions` to the history file, prints a CLI message, and blocks on `stdin`. Either edit the file directly under that header and press `ENTER` in the CLI, **or** type a one-line reply directly into the CLI and press `ENTER` — the typed text is appended under the header for you. The next phase then reads the full history (including questions + reply) and continues.
- With `auto-answer-clarifying-questions: true`: an assessment-role agent is spawned with the conversation history + `context-files` as context, instructed to answer each question concisely. Its output is appended as `## Auto Answer`. By default the pipeline still pauses for the user to press ENTER twice so the user can review/edit the auto-fill before submit. Set `auto-answer-clarifying-questions-and-submit: true` to skip that pause and proceed straight to the next phase.

Both modes preserve the original pipeline ordering — no phase is re-run, the next phase simply sees the reply/auto-answer block as additional conversation context.

---

## Background tasks

The harness registers OS-level scheduled tasks lazily on `hrun` startup so common maintenance work happens without manual intervention.

| Task name                      | Trigger                                       | What it does                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClaudeHarnessAutoResume`    | One-shot at the parsed token-limit reset time | Reads `.state/wake-queue.json` and resumes each queued topic from its saved phase index.                                                                                                                                                                 |
| `ClaudeHarnessModelsRefresh` | Weekly (Sunday 03:00 local)                   | Runs `update-models-reference.js` so `models-reference.md` stays current. Registered idempotently — re-runs of `hrun` skip if already present. Windows only. Force-refresh with `node Agent_Orchestrator/src/schedule-models-refresh.js --force`. |

---

## Interrupted runs: `continue` and auto-resume on token limit

Every phase of a pipeline writes its state to `Agent_Orchestrator/.state/<topic>.json` **before** invoking the agent, recording the pipeline name (`all`, `caf`, `pc`, …) and the index of the phase currently running. State is cleared automatically when the pipeline completes successfully.

### Manual continue (`hrun <id>-cont`)

If a phase aborts (e.g. CLI error, manual `Ctrl-C`, network blip), re-run the topic with the `continue` command — it reads the state file and resumes from that exact phase, then runs the remainder of the original pipeline:

```bash
hrun 1-cont     # equivalent to: \node Agent_Orchestrator/src/run-agent.js 1 continue
```

The previous phases' responses already sit in the history file, so the resumed phase sees the same conversation context as if the original run had not been interrupted.

### Auto-resume after token limit reset

When the Claude Code CLI exits with the session-limit banner, e.g.

```
You've hit your session limit · resets 7:20pm (Africa/Johannesburg)
[harness-run-agent.js] ERROR: Phase 3 (fix) failed: Claude exited with code 1
```

the harness:

1. parses the reset time + timezone from the captured stderr/stdout buffer;
2. persists `.state/<topic>.json` for the failed phase (same format `hrun <id>-cont` uses);
3. appends the topic to `.state/wake-queue.json` (a shared queue across all parallel topics);
4. resumes inline — the terminal blocks with a live countdown until the reset instant, then re-enters the pipeline in-process.

#### Inline resume

The terminal stays open and shows a live countdown:

```
⏳ Session resets in 00:42:17 — please keep this terminal open…
```

When the timer reaches zero it prints:

```
✅ Session reset — resuming pipeline in-process…
[harness-run-agent.js] Session reset — resuming topic "my-feature" pipeline "all" from phase index 2.
--- Phase: assessment ---
...
```

The pipeline continues from the failed phase entirely in-process — no re-spawn, no `.state/<topic>.json` round-trip between phases, because the parent process already holds the topic config, payload, and pipeline list in memory. This avoids the stale-state race that could cause an empty prompt bug on re-entry.

**If the terminal is closed or `Ctrl-C` is pressed during the countdown**, the harness exits cleanly — resume manually with `hresume <topic>` after the reset instant.

#### Diagnosing auto-resume failures

```bash
node Agent_Orchestrator/src/auto-resume.js --diagnose
```

Tails the last 50 lines of `.state/auto-resume.log`.

Disable globally with `auto-resume-on-token-limit: false` in `global-config.json` to force manual `hrun <id>-cont` after every token-limit interruption.

#### Cross-provider fallback (`fallback-providers`)

When `fallback-providers` is set in `global-config.json`, `_tryProviderFallback` is consulted **before** the inline countdown on token exhaustion: the harness swaps to the next provider in the array and re-runs the failed phase, only falling through to the countdown when the chain is empty or every listed provider has been tried. For **github-copilot** (`autoResume: false` — see the [Alternative workflows](#alternative-workflows-for-unsupported-surfaces) and [Provider Limitations](#provider-limitations) tables, where Auto-resume is hard-disabled), the fallback chain is the **only** token-exhaustion recovery path — there is no countdown to fall back to.

To enable, the operator must add `"fallback-providers": ["github-copilot"]` to `global-config.json` manually — `global-config.json` is CONFIG-GUARD-protected and is never written by an agent.

---

## Configuration (`global-config.json`)

Located at `Agent_Orchestrator/global-config.json`. Top-level keys are **kebab-case**, with one exception: the prompt-queue settings are nested under a dotted camelCase namespace (`promptQueue.autoAdvance`, `promptQueue.defaultPipeline`) — these are the real key names on disk, not a typo. Per-topic overrides live in `<topic-files-dir>/<topic>/topic-config.json` — any key present there overrides the global value for that topic via the standard cascade (`cfgRead`).

| Key                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topic-ids`                                   | Numeric shortcut map —`{ "1": "user-auth", "2": "data-dictionary" }`. Replaces the legacy `ids` + redundant `topics` registry — topic existence is now derived from values of this map plus the on-disk `<topic-files-dir>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `topic-files-dir`                             | Root folder where each topic's `<topic>/` subfolder lives. Default `Agent_Orchestrator/topic_files`. The history file is derived as `<topic-files-dir>/<topic>/<topic>.md`; per-topic settings live in `<topic-files-dir>/<topic>/topic-config.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `models`                                      | Per-role model selection:`{ "planning": "auto", "coding": "auto", "assessment": "auto" }`. Accepts `"auto"` (weighted multi-factor heuristic — same scoring as effort, maps score ≤1→haiku, 2–5→sonnet, ≥6→opus), a family alias (`opus`, `sonnet`, `haiku`), a full `claude-*` ID, or `""` (→ `claude-sonnet-4-6`). Full `claude-*` strings are resolved by family — if the exact ID is not current it resolves to the latest in that family with a note in the usage footer. Completely unrecognised names fall back to `claude-sonnet-4-6`. **When the planning agent runs, it overrides `coding` and `assessment` model** in the topic's `topic-config.json` based on the plan's assessed complexity. Auto-selected values are reset back to `auto` after each run. See [`models-reference.md`](models-reference.md) for the full model list and `auto` heuristic table.                     |
| `model-effort`                                | Per-role extended thinking level:`{ "planning": "auto", "coding": "auto", "assessment": "auto" }`. Valid values: `""` / `"none"` (no thinking), `"auto"` (weighted multi-factor heuristic — no extra LLM call), `"low"` (1 024 tokens), `"medium"` (5 000), `"high"` (12 000), `"max"` (32 000). Resolved tokens are passed to the Claude Code CLI via the `MAX_THINKING_TOKENS` env var (the CLI does not accept a `--budget-tokens` flag). **When the planning agent runs, it overrides `coding` and `assessment` effort** based on the plan's assessed complexity — giving a more accurate signal than the raw-prompt heuristic. Only Opus and Sonnet models support effort above `none` — applying effort to Haiku causes a CLI error. The active effort level is shown in the usage footer of each agent response. See [`models-reference.md`](models-reference.md) for the `auto` heuristic rules. |
| `regression-tests`                            | Appends regression-test instructions to the coding system prompt when `true`. Also enforces three additional rules: (a) every new/modified regression test must be preceded by a comment quoting the verbatim requirement bullet it covers; (b) existing tests are immutable when the requirement comment above them is unchanged; (c) conflicts between a new prompt requirement and a previously documented one must be resolved via a `## Clarifying Questions` confirmation before the test and its comment are updated in lockstep. The assessment agent audits all three.                                                                                                                                                                                                                                                                                                                                                          |
| `output-verbosity`                            | `0`–`10`. Controls terminal streaming and agent response length. `0` = no output; `1-2` = file names only; `3-4` = max 3 sentences; `5-7` = default; `8-10` = detailed explanations. When `use-caveman` is `true`, agent text content is governed by the caveman skill compression rules; this setting then only affects harness-emitted log verbosity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `auto-context`                                | When `true` (default), auto-detects directories of files modified by the agent (via `git status`) and adds them to `context-files`. Set `false` to lock the context list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `max-context-lifespan`                        | Number of runs a context entry can persist without being touched before it is removed (default `5`). Empty/`null` = never expires. Each run where a directory is modified resets its counter to 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `max-parallel-agents-per-topic`               | Cap on parallel agents fanned out within a single topic. Default `4`. `1` disables intra-topic parallelism. Excess subtasks beyond the cap are dropped. Independent of `hrun`'s cross-topic concurrency. Legacy key `max-concurrent-agents` is read as a fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `parallel-assessment-agents`                  | When `true` (default), parallel coding runs spawn an equal number of parallel assessment + remediation agents. When `false`, assessment + fix stay serial.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `context-files` (per-topic)                   | Array of directory/file paths relevant to this topic (e.g.`[{"path":"src/Foo","age":0}]`). Lives in `topic-config.json`. Injected at the top of every agent payload with a CRITICAL instruction to read these files first before searching the codebase. Auto-populated from git-modified paths after each coding run; entries age out per `max-context-lifespan`. Paths that no longer exist on disk are automatically removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `auto-answer-clarifying-questions`            | Global default for auto-answer-clarifying-questionsing `## Clarifying Questions` blocks. When `true`, the harness spawns an assessment-role agent that writes a `## Auto Answer` block using the conversation history and `context-files`. When `false` (default), the pipeline pauses and prompts on the CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `auto-answer-clarifying-questions-and-submit` | When `true` (requires `auto-answer-clarifying-questions: true`), skip the manual ENTER-twice pause after auto-answer-clarifying-questions is written and proceed straight to the next phase. Default `false` — the safe default lets the user review/edit auto-fills before submit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `stage-and-commit`                            | Auto-stages changes and generates a commit message after the final coding phase when `true`. Also saves any uncommitted user workspace changes as a separate commit **before** the agent reads the prompt, ensuring user edits are cleanly separated from agent-generated changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `use-interrogate`                             | When `true` (default), injects the interrogate clarification clauses into agent system prompts. The planning agent (and the coding agent when planning is absent from the pipeline) is instructed to refuse to act on ambiguous prompts and instead emit a `## Clarifying Questions` section. Downstream agents (coding-after-plan, assessment) receive a softer clause that suppresses re-interrogation unless a blocker remains. Set to `false` to remove all interrogate clauses.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `use-caveman`                                 | Global default for caveman-mode terse output. When `true`, appends the caveman skill body (`Agent_Orchestrator/skills/caveman/SKILL.md`) to every agent system prompt for terser output. Default `true` in the shipped config; brand-new configs default `false`. Per-topic override via `topic-config.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `use-strict-assessment`                       | When `true`, appends the strict-assessment skill body (`Agent_Orchestrator/skills/strict-assessment/SKILL.md`) to the **planning** agent's system prompt (or the **coding** agent's prompt when planning is skipped) — forcing maximally skeptical interrogation of the request before implementation. Heavy interrogation-style questioning is most valuable up front during planning, and less so during coding where the focus is on implementation. The assessment agent will still provide critical feedback and identify any missed edge cases or pitfalls without this feature enabled. Renamed from the legacy `use-devils-advocate` (which is still read as a fallback). Per-topic override via `topic-config.json`.                                                                                                                                                                                           |
| `provide-native-config-to-agents`             | Default `false`. When `false` (the default), the harness suppresses each provider's native user-config file before spawning — `~/.claude/CLAUDE.md` for Claude Code (`claude-code.js`), `~/.copilot/copilot-instructions.md` for Copilot, and `~/.gemini/GEMINI.md` for Gemini (`registry.js`). This prevents duplicate prompt/skill injections that inflate token counts when those files mirror the harness's own `CLAUDE.md` or memory payloads. **Manual deletion of `CLAUDE.md` or `.claudecode.json` for token savings is no longer required** — the suppression mechanism handles it automatically. When `true`, each provider's native config is merged into `AGENTS.md` before the spawn so the content is available, then the native file is still blanked to avoid double-loading.                                                                                                                |
| `global-rules`                                | Injected at the top of every agent payload (brevity rules, etc.).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `auto-install-shell-functions`                | Default `true`. On the first `start-topic.js` invocation, the harness calls `install-shell-functions.js` programmatically (via its exported `install()`) so users do not need a separate setup step. On success the flag flips to `false` in `global-config.json` so subsequent topic creations skip the install. On failure the flag is left as-is and a warning is logged — topic creation continues. Set to `false` to opt out entirely.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `auto-resume-on-token-limit`                  | Default `true`. When a Claude Code session aborts with `You've hit your session limit · resets H:MMam (TZ)`, the harness parses that line, persists `.state/<topic>.json` (pipeline + failed phase index), and resumes **inline**: the terminal blocks with a live countdown (`⏳ Session resets in HH:MM:SS …`) and re-enters the pipeline in-process at the failed phase. Signal during countdown (Ctrl-C/SIGHUP) exits cleanly — resume manually with `hresume <topic>`. Set to `false` to require manual `hrun <id>-cont` after every interruption.                                                                                                                                                                                                                                                                                                                                                               |
| `fallback-providers`                          | Ordered array of provider ids (e.g. `["github-copilot"]`) consulted by `_tryProviderFallback` when the active provider exhausts tokens/quota (token reset, monthly cap, or generic token-exhausted). The harness tries each id in order, swapping providers and re-running the failed phase. **Takes precedence over the inline countdown** (see `auto-resume-on-token-limit`) when set — the fallback chain is attempted first, and the countdown is only used as a fall-through when the array is empty or every listed provider has been tried. Empty/absent (default) → countdown-only recovery. Cross-references the provider fallback matrix in [Alternative workflows for unsupported surfaces](#alternative-workflows-for-unsupported-surfaces). |
| `preferred-terminal`                          | Terminal type used when the harness spawns a new window for the prompt-queue same-terminal fallback. One of `git-bash` \| `cmd` \| `powershell` \| `wt` \| `none`. Legacy key `resume-terminal` is read as a fallback with a deprecation log. (Previously also used for detached auto-resume; that path was removed when token-limit recovery became inline-only.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `network-retry`                               | Transient-network resilience for `runClaude` spawns: `{ maxAttempts, backoffMs: [ms, ms, …] }`. `maxAttempts` caps total tries; `backoffMs` is the per-attempt sleep schedule (last entry repeats if attempts > entries). Now also retries on transient API errors (HTTP `429`/`529`, `overloaded_error`) using the same backoff ladder with jitter. On all attempts failing the pipeline saves resume-state, enqueues a wake job, prints an `hresume` banner, and exits non-zero — no schtasks/at registered because wake time is unknown.                                                                                                                                                                                                                                                                                                                                                                                |
| `enableStopReasonFallback`                    | Default `false`. When `true`, the `claude-code` provider auto-continues responses that hit `stop_reason=max_tokens` (re-spawns with the prior text fed back via `<prior-assistant-output>` and an instruction to continue without repeating), capped at 3 continuations to prevent loops. `stop_reason=pause_turn` always resumes (independent of this flag); `refusal`/`end_turn` never resume; `tool_use` is left to the CLI's internal loop. When `false`, a `⚠ Truncated …` banner is appended to the agent text instead. The usage footer surfaces `stop_reason=<value>` and `continuations=<n>` whenever a non-`end_turn` stop reason fires.                                                                                                                                                                                                                                                             |
| `show-usage-stats`                            | When `true` (default), append a usage footer to every agent response (model, effort, token counts, plus `ccusage` 5h-block and weekly limit lines when available). Set `false` to hide entirely.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `play-notification-sound`                     | When `true` (default), play a short gentle chime (`.wav` via `Media.SoundPlayer`) when the harness pauses for a clarifying-question reply. Falls back to BEL on non-Windows. Set `false` to silence all harness sounds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `notification-sound-file`                     | Legacy/fallback `.wav` path. Retained for backwards compatibility — new code uses the five per-event keys below. Default `C:\Windows\Media\Windows Notify Calendar.wav`. Bundled fallback `assets/notification.wav` (CC0) ships in-repo. Relative paths resolve from the harness root; blank disables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

<!-- Five-sounds contract: ONE sound per allowed event, each a DISTINCT `.wav` file so the user can audibly distinguish "I need attention" from "new work started" from "session ended" from "out of tokens" from "fatal error". Each value is a `.wav` path (bare filenames resolve under `C:\Windows\Media`); if the value instead parses as a `"freq:durMs,..."` beep spec it plays a synthesized `[console]::beep` tone (back-compat), and a missing/locked `.wav` falls back to that event's beep sequence. Leave the value blank to fall through to the per-event `.wav` default. All five are gated by the master `play-notification-sound` switch and bridged to the parallel broker via `AMA_SOUND_*` env vars. -->

| `clarifying-sound-file`                | `.wav` for the clarifying-question pause (event 1 — user response needed). Default `Windows Notify Calendar.wav`. Beep fallback `880:150,1320:200`. Gated by `play-notification-sound`. |
| `queue-fetch-sound-file`               | `.wav` played when a new prompt is dequeued from `prompt-queue.md` (event 2 — new work started). Default `Windows Proximity Notification.wav`. Beep fallback `1046:110,784:110,1046:180`. Gated by `play-notification-sound`. |
| `completion-sound-file`                | `.wav` played when the pipeline completes AND no prompts remain (event 3 — session ending). Default `tada.wav`. Beep fallback `523:120,659:120,784:220`. Gated by `play-notification-sound`. |
| `token-limit-sound-file`               | `.wav` played when tokens are exhausted and auto-resume wait begins (event 4 — out of tokens). Default `Windows Notify Messaging.wav`. Beep fallback `700:150,700:150`. Gated by `play-notification-sound`. |
| `error-sound-file`                     | `.wav` played when an unrecoverable error forces the session to stop (event 5 — fatal error). Default `Windows Critical Stop.wav`. Beep fallback `400:200,250:320`. Gated by `play-notification-sound`. |
| `play-reminder-notifications`          | While paused awaiting a clarifying-question reply, repeat the beep every `reminder-notification-freq` seconds. Requires `play-notification-sound: true`. Default `false`. |
| `reminder-notification-freq`           | Seconds between reminder beeps while paused. `0` or empty disables the loop. Default `300`. |
| Save-All buffer flush (non-configurable) | Before re-reading the prompt file, the harness flushes unsaved editor buffers via a keystroke sent to the focused editor window. The Save-All chord is auto-detected from the running IDE's `keybindings.json` (VS Code / Cursor / VSCodium, command `workbench.action.files.saveAll`) with `^(k)s` fallback. Flush timing and window-match are now hardcoded defaults — no longer configurable. |
| `stream-output`                        | Stream agent output to terminal in real time. Default `true`. |
| `streaming-heartbeat-ms`               | Print a "Still working…" message after this many ms of silence. Default `5000`. |
| `context-truncation`                   | Max characters kept from each historical agent response in the context window. Default `400`. Increase for more context at the cost of more tokens. |
| `promptQueue.autoAdvance`              | See [Prompt Queue](#prompt-queue-auto-advance-multiple-prompts). |
| `promptQueue.defaultPipeline`          | See [Prompt Queue](#prompt-queue-auto-advance-multiple-prompts). |
| `system-prompts.planning`              | System prompt for the planning agent. |
| `system-prompts.coding`                | System prompt for the coding agent. |
| `system-prompts.assessment`            | System prompt for the assessment agent. |

### Design decisions (verbosity flag and skill-routed assessment)

- **Caveman vs CLI verbosity flag**: investigated replacing `use-caveman` with a native Claude CLI verbosity argument passed to `runClaude`. The Claude CLI exposes only `--verbose` (a boolean toggle for stream-json debug events) — no tiered terseness flag. The harness's existing `output-verbosity` config is a prompt-shaping mechanism (controls action-suffix wording and diff truncation budgets), not a CLI passthrough. Conclusion: native flag insufficient to replace caveman's content-shaping prompt clauses; caveman wiring stays.
- **Assessment system-prompt as skill**: investigated extracting `buildSystemPrompt('assessment')` content into a `skills/assess/SKILL.md` and thinning the inline prompt to a skill-invocation directive. Net loss: (1) the harness uses `claude --print` headless — skills require the agent to invoke the `Skill` tool itself, adding a tool round-trip per assessment; (2) the assessment system prompt is already small (~600 chars) and cached across invocations; (3) routing through a skill removes the prompt from the explicit cached system-prompt position. Conclusion: kept inline.

---

## Provider Selection

### Switching providers

1. Edit `global-config.json` → set `"provider": "<id>"` where id ∈ `{claude-code, github-copilot}`.
2. Run `node Agent_Orchestrator/src/run-agent.js --probe` to verify auth + binary present.
3. On failure, harness prints provider's login instructions and exits non-zero.

### Per-provider operational notes

- **claude-code:** full feature set. No config changes required from current setup.
- **github-copilot:** Uses standalone `copilot` CLI (NOT `gh copilot`). Headless invocation: `copilot -p "<prompt>" --allow-all-tools --log-dir <dir>`. MCP and tool-use supported. No sub-agents, no skills runtime, no plan-mode, no auto-resume, no stream-json. Output structured via `--log-dir` JSONL. Premium-request quota applies (Pro: 300/mo; Business: 1500/mo). AGENTS.md auto-generated from CLAUDE.md+MEMORY at spawn.

### Alternative workflows for unsupported surfaces

| Surface                 | claude-code                                       | github-copilot fallback                                                   |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Plan mode               | native `--plan-mode`                            | two-pass prompt: explicit `<plan>` tags → harness pause → coding pass |
| Skills                  | `use_mcp_tool` tool + auto-discovery            | inline selected SKILL.md bodies into system prompt (size cap 8 KB)        |
| Sub-agents (Task/Agent) | recursive `claude` spawn                        | harness-level sequential via `runFleet()`                               |
| Auto-resume             | ✓                                                | hard-disabled,`hresume` banner printed                                  |
| Hooks                   | settings.json `PreToolUse`/`PostToolUse` etc. | phase-3 (deferred)                                                        |

Every fallback emits a `[provider:copilot]` warning on first invocation so users are not surprised by silent behaviour changes.

---

## Provider Limitations

| Feature               | claude-code | github-copilot                                   |
| --------------------- | ----------- | ------------------------------------------------ |
| Streaming JSON events | ✓          | ✗                                               |
| MCP tools             | ✓          | ✓ (`--mcp-config` + `/mcp` slash-cmd)       |
| Sub-agents            | ✓          | emulated (sequential)                            |
| Skills runtime        | ✓          | inlined (8 KB cap)                               |
| Plan mode             | ✓          | two-pass                                         |
| Auto-resume           | ✓          | ✗                                               |
| Hooks                 | ✓          | harness-emulated (phase-3)                       |
| Token + cache stats   | ✓          | ✗                                               |
| Model choice          | ✓          | ✓ (`--model` cmd or `copilot.model` config) |
| Session resume        | ✓          | ✗                                               |

---

## Troubleshooting

### `spawn claude ENOENT` / `'claude' is not recognized as an internal or external command`

**Symptom.** A pipeline phase aborts immediately:

```text
--- Phase: coding ---
ERROR: Phase 1 (coding) failed: spawn claude ENOENT
```

or, when a shell is involved:

```text
ERROR: Phase 1 (coding) failed: Claude exited with code 1
--- claude output ---
'claude' is not recognized as an internal or external command,
operable program or batch file.
```

**Cause.** The harness spawns the provider CLI (`claude`, `gemini`, or `copilot`) as a child process. The child cannot find the CLI binary because it is not resolvable from the environment Node hands to `spawn`. On **Windows + Git Bash** this is common: the interactive Git Bash `PATH` is Unix-style (`/c/Users/...`), which neither Windows' `spawn` lookup, `cmd.exe`'s `where`, nor a non-login `bash` can resolve. The binary exists and works when you type it yourself — but the spawned child can't see it.

A frequent specific case: **Claude Code installed as a VS Code (or Cursor) extension** rather than as an npm package. The binary then lives at
`~/.vscode/extensions/anthropic.claude-code-<version>/resources/native-binary/claude.exe`
and is never on `PATH` at all — VS Code injects it only into its integrated terminal.

#### Fix for `claude-code`

The harness resolves the Claude binary automatically (see `resolveClaudeExec()` in [`src/lib/providers/claude-code.js`](src/lib/providers/claude-code.js)), trying in order:

1. **`CLAUDE_BIN` / `CLAUDE_EXEC_PATH` env var** — an explicit absolute path. This always wins and is the recommended override on a machine where auto-discovery fails.
2. **VS Code / VS Code Insiders / Cursor extensions directory** — the newest `anthropic.claude-code-*/resources/native-binary/claude.exe` on disk. This covers the extension-install case above.
3. **`cmd.exe where claude`** — for npm-global installs that *are* on the real Windows `PATH`.
4. **Git Bash `which claude`** — at the standard `C:\Program Files\Git\...\bash.exe` locations, converting the resulting Unix path to a Windows path.

If all four fail on a new PC, set an explicit override. The path must point at the real executable:

```bash
# Git Bash / macOS / Linux — add to ~/.bashrc (or ~/.zshrc) so it persists:
export CLAUDE_BIN="/c/Users/<you>/.vscode/extensions/anthropic.claude-code-<version>/resources/native-binary/claude.exe"
```

```powershell
# PowerShell (persist for your user):
setx CLAUDE_BIN "C:\Users\<you>\.vscode\extensions\anthropic.claude-code-<version>\resources\native-binary\claude.exe"
```

To find the path yourself, run `which claude` (Git Bash) or `where claude` (cmd/PowerShell) in a terminal where `claude` works — e.g. the VS Code integrated terminal.

> **Tip:** if `claude` is installed via npm (`npm i -g @anthropic-ai/claude-code`), its `claude.cmd` shim lands in your npm global bin (`npm prefix -g` + `\` on Windows). Adding that directory to your **Windows** `PATH` (not just the Git Bash `PATH`) lets steps 3–4 resolve it without an override.

#### Fix for `gemini` and `github-copilot`

These providers are standalone npm CLIs (`@google/gemini-cli`, GitHub Copilot CLI). The harness resolves them by trying the bare command first (`gemini` / `copilot`, `shell: false`) and falling back to the `.cmd` shim with `shell: true` on Windows (see `resolveGeminiBin()` in [`src/lib/providers/gemini.js`](src/lib/providers/gemini.js) and `resolvecopilotBin()` in [`src/lib/providers/github-copilot.js`](src/lib/providers/github-copilot.js)). Both rely on the CLI being on the **Windows `PATH`**, so the fix is to make sure it is:

1. Confirm the install and find the shim:

   ```bash
   where gemini      # cmd/PowerShell — should print ...\gemini.cmd
   where copilot     # should print ...\copilot.cmd
   npm prefix -g     # the directory those shims live in
   ```
2. If `where` finds nothing, (re)install the CLI globally and ensure the npm global bin directory is on your Windows `PATH`:

   ```bash
   npm i -g @google/gemini-cli          # Gemini
   npm i -g @github/copilot             # GitHub Copilot CLI (NOT `gh copilot`)
   ```
3. Open a **new** terminal (PATH changes don't apply to already-open shells) and re-verify with `gemini --version` / `copilot --version`.

#### Verify the fix

Run the provider probe — it uses the exact same binary-resolution path as a real run, so a green probe means pipelines will spawn correctly:

```bash
hprobe          # or: node Agent_Orchestrator/src/run-agent.js --probe
```

On success it prints the resolved CLI version. On failure it prints that provider's login/install instructions and exits non-zero.
