# Prompt Queue

<!--
Queued prompts run automatically after the current pipeline finishes
(when `promptQueue.autoAdvance` is true).

EDIT FREELY: Save this file at any time in any editor. The next drain
after your save picks up the latest content from disk — the harness
never caches parsed queue state across phases.

FORMAT:
  - Optional header on the first non-blank line of a block:
      `Pipeline: caf`   or just `caf`  (any shorthand from shell-functions.txt)
  - Missing header -> uses `promptQueue.defaultPipeline` (default `all`).
  - Separate blocks with a line containing only `---`.

HOLD MARKER:
  - Inline:    `Pipeline: caf (hold)` or `pcaf (hold)` on the header line.
  - Body:      `hold` / `(hold)` / `[hold]` / `<HOLD>` as the FIRST non-blank
               line. May sit under a header OR stand alone above a
               header-less prompt body — no `Pipeline:`/shorthand required.
  Held blocks are skipped during dequeue and left in place.

EXAMPLE (uncomment to use):

  Pipeline: caf
  Add the foo bar feature to the widget service.

  ---

  pcaf
  Then refactor the widget cache to use LRU.

  ---

  (hold)

  Standalone hold above a header-less prompt — skipped during dequeue.
  Remove the `(hold)` line above when ready to dispatch this prompt.
-->

---

(hold)

We must also create a fallback to another provider when tokens run out. This should happen automatically with a message on the CLI saying "Tokens have run out on your subscription with {provider name}, falling back to {provider name}". Then the usual countdown logic kicks in if no tokens are available on any of the available providers. It refers back to the primary provider and displays the time until tokens are back, then re-initializes automatically when the tokens have arrived. If this is not possible, (If for example, the user does not have a Claude Code subscription which enables this); then the CLI must make clear that an auto-resume is not possible on the available providers: [list providers].

---

(hold)

I want to address the regression testing according to the findings in `Agent_Orchestrator\topic_files\claude_harness\test-suite-diagnostic.md`. I switched the provider to  `github-copilot`, as instructed under `Setup blocker requiring user action` at the borrom of `test-suite-diagnostic.md`.
