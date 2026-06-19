---
name: history-self-lookup
description: Lazily look up prior-turn context from the topic history file on demand instead of receiving a pre-truncated dump. Use when a user prompt references earlier turns, prior answers, prior agent responses, or otherwise lacks self-contained context.
---
The harness has NOT injected a compressed-memory block or a truncated context snapshot. The full conversation history lives on disk at the path explained below. Read it lazily only when you need it.

## Files

- `<promptHistoryFile>` — full markdown history of the prompts and responses for this topic
  - Located in `Agent_Orchestrator\topic_files\claude_harness\claude_harness.md` for the `claude-harness` topic; all topics have their own history files in the same relative path under `topic_files`.
  - Append-only; agent responses are separated by level 2 headings such as `## Planning Agent Response`, `## Coding Agent Response`, `## Assessment Agent Response`, and user prompts by `## User Prompt`.
  - Sometimes referred to as the "prompt file" or "histroy file".
- `<historyLineCount>` — current line count of `<promptHistoryFile>` (use this to compute an `offset` for the `Read` tool when you want only the tail).
- `<queueFile>` — pending queued prompts, if any.
  - Located in `Agent_Orchestrator\topic_files\claude_harness\prompt-queue.md` for the `claude-harness` topic; all topics have their own queue files in the same relative path under `topic_files`.
  - Sometimes referred to as the "queue file" or "prompt queue".

## When to look up

Look up history when ANY of these are true for the current user prompt:

- It uses pronouns or demonstratives without antecedent (eg. "it", "that", "this bug", "current issue", "previous issue", "the file we changed").
- It references prior turns ("earlier", "previously", "you said", "what you suggested", "the plan above", "the assessment").
- It is a continuation phrase ("now do X too", "also", "and then", "next").
- It asks for a fix, remediation, or follow-up to something not stated in this turn.
- You need a file path, function name, or decision that an earlier turn established.

If any antecedent is implicit, read history first. A wasted lookup on the first turn is acceptable; a missed lookup that produces a wrong answer is not.

## How to look up

Read the file bottom-up in chunks of ~200 lines using the `Read` tool with `offset` derived from `<historyLineCount>`:

- Start with `offset = max(1, <historyLineCount> - 200)` to read the tail.
- If the answer requires earlier turns, page upward by 200 lines at a time.
- Stop as soon as you have enough context. Do NOT read the whole file by default.

Skip any block delimited by `<!-- archived ... -->` or `<!-- CLEAR CONTEXT -->` markers — those summarize rotated content and should be read only if no live block answers the question.

If `<historyLineCount>` is 0 or 1, or the file contains only a single `## User Prompt` block with no responses, the history is empty — no lookup needed.

## What to ignore

- Do not edit the history file. The harness appends your response automatically.
- Do not narrate "let me read the history file" to the user — just do it.
- Do not re-read the same chunk twice in one turn.
