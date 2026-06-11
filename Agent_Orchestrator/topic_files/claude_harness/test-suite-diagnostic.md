# Test Suite Diagnostic — why regressions slip past

## Setup deviation

- `global-config.json` provider switch to `github-copilot` was **NOT applied**: harness `CONFIG GUARD` (system prompt) forbids the coding agent from editing `global-config.json`. User must flip `provider` manually before remediation runs. Current value: `"provider": "claude-code"` at `global-config.json:3`.

## Hypotheses evaluated (verdict + evidence)

### H1 — Over-mocking / source-string assertions instead of behaviour — **CONFIRMED**

- 40 of ~50 test files grep run-agent source as a string: `rg -c "src\.includes|src\.match|SRC\.includes|SRC\.match" tests/` → **166 occurrences across 40 files**.
- `tests/build-system-prompt.test.js:35` asserts a regex against the source text (`role === 'planning'\s*\)\s*prompt \+= planningStrictAssessmentClause`). Refactor the wiring and the test passes even if the clause never reaches the model. Behaviour (built prompt string for a given role) is never invoked.
- `tests/build-system-prompt.test.js:131-156` does the same for `codingConfigGuardClause` and `assessmentConfigAttributionClause` — pattern-match on source, no call to `buildSystemPrompt(role)`.
- `tests/provider-integration.test.js:54-64,67-72,76-80` — PI3/PI4/PI5 each assert `require(...)` strings or `capabilities.X` substrings exist inside source files. Removing the *behaviour* but leaving the string keeps the test green.
- `tests/compress-memory-provider.test.js:34-42` asserts regex `await.*provider\.spawn` against source — does not actually run `callClaude`.

### H2 — Mid-layer integration coverage missing — **CONFIRMED**

- 166 source-grep tests vs zero spawn-the-real-`run-agent.js` integration tests. Closest is `tests/harness-config-rename.test.js:13` — spawns a config-rename utility, not `run-agent.js`. `tests/dispatch-iife-drain-after-clarify-rerun.test.js:18` carries an explicit comment: *"A strict spawn `node src/run-agent.js` with a stubbed pipeline e2e was [skipped]"* — i.e. the team acknowledged the gap and chose not to fill it.
- `tests/history-auto-archive.test.js:33-39` extracts the archive function via `new Function('fs','path','log','config',...)` factory. The function runs in isolation, never wired through `run-agent.js` exit handlers / restore paths / config cascade. Bugs in *how it is called* (wrong threshold cascade, missing await, exit handler races) cannot be caught.
- Same pattern at `tests/history-archive-injects-compressed-context.test.js:28-34,45-54` (factories `buildParseFn` and `buildArchiveFn`) and `tests/provider-integration.test.js:227-237` (PI13-runtime factories `restoreAutoModelFields`).

### H3 — Narrow-input regression tests / no provider matrix sweep — **CONFIRMED**

- `tests/parallel-broker.test.js:38-59` (`makeBroker`) creates exactly one broker shape (non-TTY, jobs of size 2-3, no env). FIFO is asserted with 2 or 3 fake children only.
- `tests/parallel-broker.test.js:203-215` (`mockRegistryForStart`) parameterises *only* `subAgents` (true/false). `planMode`, `skillsRuntime`, `autoResume` never varied — yet they influence broker behaviour in code.
- `tests/provider-integration.test.js:131-161` PI9/PI10 only assert that auto-model tiers are *not* Claude IDs. No test actually drives `resolveModel` end-to-end for each provider with a real prompt + topic-config cascade. Verified at `tests/provider-integration.test.js:250-283` (PI14-runtime) — uses `new Function` factory for **one** provider/path; matrix never run.
- No test parameterises across `{claude-code, github-copilot, gemini, gemini-vertex} × {planning, coding, assessment} × {auto, explicit-model}`. That matrix has 24 cells — each provider test file covers ~1 column.

### H4 — Tests assert internal call shape, not user-visible behaviour — **CONFIRMED**

- `tests/parallel-broker.test.js:63-81` reaches into `broker._state.active.token`, `broker._state.pendingQuestions` — private fields. A refactor that splits state across two maps but preserves observable FIFO would fail this test even though behaviour is correct (false negative); inversely, a bug that corrupts the token *delivered to stdout* but keeps `_state` consistent would pass (false positive).
- `tests/parallel-broker.test.js:68-69` calls `broker._enqueue(...)` — an internal seam, not the public surface. The actual `start()` path is exercised only in PB-S1/PB-S2 (`tests/parallel-broker.test.js:217-275`) and *those* assert on stdout strings (`/Launching.*job.*broker/`), so a stdout-format change breaks the test even with correct behaviour.
- `tests/github-copilot-provider.test.js:363-404` asserts `setInterval` is called exactly once with delay `5000` — instrumenting timers globally. A move to a self-pacing loop with the same user-visible heartbeat would fail this test.

### H5 — End-to-end "prompt in → history out" harness test absent — **CONFIRMED**

- `rg -l "node.*run-agent\.js" tests/` returns zero hits (no test spawns the entry point).
- No test writes a real `topic_files/<topic>/<topic>.md` with `## User Prompt`, runs the full pipeline, and asserts the resulting `## Coding Agent Response` block was appended correctly. The full prompt→history pipeline (`fillEmptyPromptFromQueueOrInteractive` → `runClaude` → `appendToFile` → `maybeAutoArchiveHistory`) has zero integration coverage.

### H6 — Snapshot / golden-file drift — **REJECTED**

- `rg -l "toMatchSnapshot|snapshot|golden" tests/` → no hits. No snapshot infrastructure exists; this hypothesis does not apply.

### H7 — Regression-capture rule not enforced — **CONFIRMED (partial)**

- `tests/regression-test-policy.test.js` exists (1 mock count) but is a self-policing meta-test, not a per-bug regression. Bug fixes land with source-grep tests (see `tests/history-auto-archive.test.js:54-57` checks for `fs.writeFileSync` substring) rather than failing-first behavioural tests.

## Remediation plan (no code — approval gate)

### Tests to add

1. `tests/e2e-harness-prompt-to-history.test.js` — spawns `node src/run-agent.js` against a temp `topic_files/<topic>/` with a planted `## User Prompt`, stubs provider HTTP by injecting `PROVIDER=stub-fixture` (new provider module: `src/lib/providers/stub-fixture.js` reading canned JSONL from `tests/fixtures/`). Asserts: history file gained `## Coding Agent Response`, archive triggered above threshold, queue dequeued, `_harness_auto_set` cleaned. **Locks H2 + H5.**

2. `tests/provider-matrix.test.js` — parameterised over `providers × roles × model-config`. For each cell, calls real `buildSystemPrompt(role)` / `resolveModel(...)` (no source-grep) and asserts: returned prompt string contains required clauses, returned model arg list starts with provider-native ID, `cfgRead` cascade resolves provider correctly. **Locks H1 (replaces `tests/build-system-prompt.test.js` source-greps) + H3.**

3. `tests/parallel-broker-public-surface.test.js` — drives the broker through `broker.start()` only (no `_enqueue` / `_state` reads). Observable inputs: `jobs`, fake child `send`/`emit('close')`. Observable outputs: stdout banner ordering, `child.sent` payloads, exit-code aggregation. Re-implement FIFO/routing/exit/sound/prefix cases at this layer; `_state` peeks deleted. **Locks H4.**

4. `tests/regression-rule-failing-first.test.js` — lint-style test: every file in `tests/` whose name matches `*regression*` or `*bug*` must (a) have a Git tag/comment referencing the issue, (b) contain at least one assertion that exercises a *spawn*-based or *require*-based call site (not a `src.includes`). Fails CI if a new regression test ships as source-grep only. **Locks H7.**

5. `tests/history-pipeline-integration.test.js` — exercises `maybeAutoArchiveHistory` *via* `run-agent.js` (child_process.fork on the actual module export, not `new Function` factory). Asserts archive replaces file, trailing `## User Prompt` present, second invocation is no-op — same cases as `tests/history-auto-archive.test.js` but at integration layer so wiring bugs are caught. **Locks H2.**

### Exit criteria for remediation phase

- Every confirmed hypothesis has at least one new test in the list above.
- New tests MUST drive the public surface (spawn the binary, call the exported fn) — no `readFileSync(run-agent.js)` + `.includes()` in any new file.
- After remediation, `rg -c "SRC\.includes|src\.includes" tests/` should trend downward as legacy source-grep tests are deleted in favour of behavioural replacements (target: <50 occurrences, currently 166).
- Coding agent **stops here**. Does not implement remediation until user approves the plan.

## Setup blocker requiring user action

- Flip `global-config.json` `"provider"` to `"github-copilot"` manually (config-guard prevents agent edit). Verify with `rg '"provider"' Agent_Orchestrator/global-config.json` → expect `"provider": "github-copilot"`.
