---
name: regression-test
description: >
  Behavioural regression-test discipline derived from the test-suite
  diagnostic (H1-H7). Forbids source-string assertions, factory-isolated
  units, narrow-input tests, and private-field peeks. Use when writing or
  reviewing harness regression tests so bugs cannot slip past green tests.
---

## Mindset

A passing test that exercises no real code path is worse than no test — it grants false confidence. Every regression test must FAIL if the bug it guards re-appears, and PASS only because the public behaviour is correct. Drive the public surface, not the source text.

## Hard Rules (each maps to a confirmed diagnostic hypothesis)

- H1 — NO source-string assertions. Do NOT `readFileSync('src/run-agent.js')` then assert `src.includes(...)` / `src.match(/.../)` / `SRC.includes(...)`. Refactoring the wiring must be able to break the test. Instead call the exported function (e.g. `buildSystemPrompt(role)`, `resolveModel(...)`) or spawn `node src/run-agent.js` and assert on the returned value / stdout / written file.

- H2 — Cover the mid-layer, not just isolated units. Do NOT extract a function via `new Function('fs','path',...)` factories and test it in a vacuum. Wire through the real module export (`require`, `child_process.fork`) so call-site bugs (wrong cascade, missing `await`, exit-handler races) are caught.

- H3 — Parameterise the matrix, not one shape. When behaviour varies by provider × role × model-config (or any axis the code branches on), drive each cell. Do not hard-code a single non-TTY broker, one provider, or only `subAgents` true/false — vary every capability the code reads (`planMode`, `skillsRuntime`, `autoResume`, ...).

- H4 — Assert user-visible behaviour, not internal call shape. Do NOT reach into private seams (`broker._state`, `broker._enqueue`, `_pendingQuestions`) or instrument globals (`setInterval` called once with `5000`). Drive the public entry (`broker.start()`) and assert observable outputs: stdout ordering, payloads sent to children, exit codes, written files.

- H5 — Provide end-to-end prompt→history coverage where the change touches the pipeline. At least one test should plant a real `## User Prompt` in a temp `topic_files/<topic>/`, run the full pipeline (stubbed provider), and assert the resulting `## Coding Agent Response` block was appended, archive triggered, queue dequeued.

- H7 — Failing-first, per-bug. Each bug fix ships with a behavioural test that FAILS on the pre-fix code and PASSES after. Name it for the bug (`*-regression.test.js` / `*-bug.test.js`), and add a comment quoting the VERBATIM requirement / issue it locks. No source-grep-only regression tests.

## Procedure

1. Before writing the test, name the exact input that makes the bug re-appear and the exact observable output that proves it fixed. If you cannot, you are not testing behaviour.

2. Reach the code under test through its public surface only — exported function call or spawned process. If the only way to test it is a private field or a `new Function` factory, treat that as a design smell and prefer wiring through the real entry point.

3. Cover boundaries: null, empty, off-by-one, unicode, concurrent write, cancellation, unexpected schema. One happy-path assertion is not a regression test.

4. For multi-axis behaviour, build the cell list explicitly and loop — assert every cell, and `log`/comment any axis you deliberately skip (no silent truncation).

5. Run the full suite and confirm green before declaring done. A test that cannot be run is not a test.

## Anti-patterns (reject on sight)

- `expect(src).toMatch(/role === 'planning'/)` — refactor-proof, behaviour-blind.
- `const fn = new Function('fs', body); fn(...)` — isolated from real call site.
- `expect(broker._state.active.token).toBe(...)` — private seam, false pos/neg.
- `expect(setInterval).toHaveBeenCalledWith(fn, 5000)` — instruments timing, not heartbeat.
- One provider / one broker shape standing in for a matrix.

## Exit Criteria

Test is acceptable only when: it drives the public surface (no source-grep, no factory, no private field), it would FAIL on the unfixed code, it covers the relevant input boundaries and matrix cells, and the full suite is green.
