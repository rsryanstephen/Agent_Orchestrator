---
name: regression-test
description: >
  Behavioural regression-test discipline derived from the test-suite
  diagnostic (H1-H7). Forbids source-string assertions, factory-isolated
  units, narrow-input tests, and private-field peeks. Use when writing or
  reviewing harness regression tests so bugs cannot slip past green tests.
---

## Mindset

A test exercising no real code path grants false confidence. Every regression test must FAIL if the bug re-appears; PASS only because behaviour is correct. Drive public surface, not source text.

## Hard Rules (each maps to a confirmed diagnostic hypothesis)

- H1 — NO source-string assertions. Refactoring must break test; call exported fn not src text via `readFileSync()`.

- H2 — Cover mid-layer via real module export (require, child_process.fork), not factories; catches call-site bugs (wrong cascade, missing await).

- H3 — Parameterise the matrix (provider × role × config); vary every capability the code branches on, not single hard-coded shapes.

- H4 — Assert observable outputs (stdout, payloads, exit codes, files), not private seams (_state, _enqueue); drive public entry not internals.

- H5 — End-to-end prompt→history coverage: plant real `## User Prompt` in temp `topic_files/<topic>/`, run full pipeline, assert `## Coding Agent Response` appended and archive/queue triggered.

- H7 — Failing-first per-bug: test FAILS on pre-fix, PASSES after; name for bug; quote VERBATIM requirement. No source-grep-only tests.

## Procedure

1. Name exact input + observable output proving fix; cannot test behaviour without both.

2. Public surface only (exported fn, spawned process); private fields = design smell — wire through real entry point.

3. Cover boundaries: null, empty, off-by-one, unicode, concurrent write, cancellation, unexpected schema.

4. Multi-axis behaviour: explicit cell-list loop; assert all cells, log any deliberate skips (no silent truncation).

5. Full suite green before done; untestable code is not tested.

## Anti-patterns (reject on sight)

- `expect(src).toMatch(/role === 'planning'/)` — refactor-proof, behaviour-blind.
- `const fn = new Function('fs', body); fn(...)` — isolated from real call site.
- `expect(broker._state.active.token).toBe(...)` — private seam, false pos/neg.
- `expect(setInterval).toHaveBeenCalledWith(fn, 5000)` — instruments timing, not heartbeat.
- One provider / one broker shape standing in for a matrix.

## Exit Criteria

Public surface (no grep/factory/privates) → FAILS on unfixed code → covers boundaries + matrix → full suite green.
