---
name: history-self-lookup
description: Lazily look up prior-turn context from the topic history file on demand instead of receiving a pre-truncated dump. Use when a user prompt references earlier turns, prior answers, prior agent responses, or otherwise lacks self-contained context.
---
The harness has NOT injected a compressed-memory block or a truncated context snapshot. The full conversation history lives on disk at the path explained below. Read it lazily only when you need it.

## Files

- `<promptHistoryFile>` — full markdown history; append-only; agent responses under `## Planning Agent Response`, `## Coding Agent Response`, `## Assessment Agent Response`; user prompts under `## User Prompt`. Also called "prompt file" or "history file". Located at the same relative path under `topic_files` for every topic (e.g. `Agent_Orchestrator\topic_files\claude_harness\claude_harness.md`).
- `<historyLineCount>` — current line count of `<promptHistoryFile>`; use to compute `offset` for the `Read` tool.
- `<queueFile>` — pending queued prompts, if any. Also called "queue file" or "prompt queue". Located at the same relative path under `topic_files` (e.g. `Agent_Orchestrator\topic_files\claude_harness\prompt-queue.md`).
- If the live history file was recently archived, prior content lives in a sibling file named `<topic>.archive-<timestamp>.md` in the same directory — glob or inspect the directory when older context is needed.

## When to look up

Look up history when ANY of these are true: the prompt uses pronouns or demonstratives without antecedent ("it", "that", "this bug", "the file we changed"); references prior turns ("earlier", "you said", "the plan above"); is a continuation phrase ("now do X too", "also", "next"); asks for a fix or follow-up to something not stated in this turn; or requires a file path, function name, or decision established in an earlier turn. If any antecedent is implicit, read history first — a wasted lookup is cheaper than a missed one.

## How to look up

Read bottom-up in chunks of ~200 lines: start with `offset = max(1, <historyLineCount> - 200)`, page upward by 200 lines at a time if needed, stop as soon as you have enough context. Skip blocks delimited by `<!-- archived ... -->` or `<!-- CLEAR CONTEXT -->` markers — those summarize rotated content and should be read only if no live block answers the question. If `<historyLineCount>` is 0 or 1, or the file has only a single `## User Prompt` with no responses, the history is empty — no lookup needed.

## What to ignore

Do not edit the history file (harness appends automatically), do not narrate "let me read the history file" to the user, and do not re-read the same chunk twice in one turn.
