# Prompt Queue

<!--
Queued prompts run automatically after the current pipeline finishes
(when `promptQueue.autoAdvance` is true).

FORMAT:
  - Optional header on the first non-blank line of a block:
      `Pipeline: caf`   or just `caf`  (any shorthand from shell-functions.txt)
  - Missing header -> uses `promptQueue.defaultPipeline` (default `all`).
  - Separate blocks with a line containing only `---`.

EXAMPLE (uncomment to use):

  Pipeline: caf
  Add the foo bar feature to the widget service.

  ---

  pcaf
  Then refactor the widget cache to use LRU.
-->

---
