---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---
# Karpathy Guidelines

Reduce common LLM coding mistakes. [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876).

Toward caution over speed. Judgment on trivial tasks.

## 1. Think Before Coding

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what user asked for.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Senior engineer say overcomplicated? Simplify.

## 3. Surgical Changes

Touch only what must.

Editing: No adjacent "improvements". Match style. Unrelated dead code? Mention it.

You make unused imports/variables/functions? Remove them. Pre-existing dead code? Leave.

Test: Changed line trace to request? Yes/no.

## 4. Goal-Driven Execution

Define success. Loop until verified.

Tasks → verifiable goals:
- "Add validation" → test invalid inputs, make pass
- "Fix bug" → reproduce in test, make pass
- "Refactor X" → tests pass before/after

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong criteria independent loop. Weak ("make work") needs clarification.
