## User Prompt (From the Queue)

As was done for Copilot, Make this harness compatible with Gemini as well.

Be sure to cover all the previous steps that we covered when making the sonos compatible with Copilot.

---

## Planning Agent Response

- Add `src/lib/providers/gemini.js` mirroring `github-copilot.js` shape: `id: 'gemini'`, `capabilities` (mcp=true, tools=true, planMode/skillsRuntime/subAgents/autoResume/streamJson/hooks/permissionMode=false), `probe()` via `gemini --version` (Windows fallback to `gemini.cmd`), `loginInstructions()` (install `@google/gemini-cli`, run `gemini auth` or set `GEMINI_API_KEY`), `spawnGemini({prompt,model,cwd})` using `gemini -p <prompt> --yolo` (or equivalent non-interactive + auto-approve flag) writing JSONL to a temp `--log-dir` if supported else parse stdout, `parseStream(exitCode,logDir,stderrBuf)` emitting normalized `assistant_text`/`tool_call`/`tool_result`/`usage`/`error`/`done` events, plus `cleanupLogDir`; flag any field mappings as `[NEEDS-VERIFICATION]` since Gemini CLI schema is post-cutoff.
- Wire into `src/lib/providers/registry.js`: add `'gemini': () => _adaptModule(require('./gemini'))` to `KNOWN_PROVIDERS`; `_adaptModule` already resolves `mod.spawnCopilot || mod.spawn` so expose `spawn` (rename `spawnGemini` -> `spawn` export alias) so adapter picks it up; AGENTS.md setup path is shared and reused — note Gemini CLI's native context file is `GEMINI.md`, so either (a) make `agents-md-generator.setup()` accept a `contextFileName` and pass `'GEMINI.md'` from the gemini branch, or (b) keep `AGENTS.md` and rely on Gemini's `--context-file` flag (risk: Gemini may not auto-load `AGENTS.md`).
- Update `global-config.json`: extend the `// provider` doc comment to list `gemini` as a third option with one-line install hint; do not change the default `provider` value.
- Tests to add/extend: `tests/gemini-provider.test.js` (unit, mirrors `github-copilot-provider.test.js` — covers `_parseGeminiLogEntry`, `_readLogDirJsonl`, capability flags, `loginInstructions` string), `tests/gemini-smoke.test.js` (mirrors `copilot-smoke.test.js`, skipped when `probe()` false), and add a `gemini` case to `tests/provider-registry.test.js` (factory resolution + unknown-id error message includes `gemini`) and `tests/provider-integration.test.js` (adapter spawn -> events normalization with a stubbed `spawn`).
- Risks/ambiguities to track inline (do not block plan): Gemini CLI binary name (`gemini` vs `npx @google/gemini-cli`), non-interactive prompt flag (`-p` vs `--prompt` vs stdin), log output mode (`--log-dir` JSONL vs stdout JSON vs plain text — may require parsing stdout into events instead of post-exit dir read), tool-approval flag (`--yolo`/`--auto-approve`/none), and whether Gemini honors `AGENTS.md` (likely needs `GEMINI.md` symlink or rename in `agents-md-generator`); all such assumptions tagged `[NEEDS-VERIFICATION]` in code comments per the Copilot precedent.

## Parallel Tasks

1. Create `src/lib/providers/gemini.js` modeled exactly on `src/lib/providers/github-copilot.js` (lines 1-357): same export shape (`id`, `capabilities`, `supportsFeature`, `probe`, `loginInstructions`, `spawn` [aliased so adapter picks it up], `parseStream`, `cleanupLogDir`, `_parseGeminiLogEntry`, `_readLogDirJsonl`). Replace `copilot` with `gemini` throughout, set `id: 'gemini'`, write `loginInstructions()` for `@google/gemini-cli` (install via `npm i -g @google/gemini-cli`, auth via `gemini auth` or `GEMINI_API_KEY` env var, verify `gemini --version`). Spawn args: `['-p', String(prompt), '--yolo', '--log-dir', logDir]` plus `['--model', model]` when set. Keep all `[NEEDS-VERIFICATION]` comments for log-entry field mappings.
2. Patch `src/lib/providers/registry.js`: add line in `KNOWN_PROVIDERS` map: `'gemini': () => _adaptModule(require('./gemini'))`. No other changes. Extend `agents-md-generator.setup()` signature to optionally accept `{contextFileName}` and pass `'GEMINI.md'` when adapting the `gemini` module (detect via `mod.id === 'gemini'` inside `_adaptModule`); leave Copilot path unchanged (defaults to `AGENTS.md`).
3. Update `global-config.json` (top-level `// provider` comment only): change to list three options — `claude-code` (default) | `github-copilot` | `gemini` (standalone `gemini` CLI, requires `GEMINI_API_KEY` or `gemini auth`). Do not change `provider` value. Touch nothing else in the file.
4. Add `tests/gemini-provider.test.js` mirroring `tests/github-copilot-provider.test.js`: unit-test `_parseGeminiLogEntry` for each event kind (`message`/`tool_call`/`tool_result`/`usage`/`error`/`error_quota`), `_readLogDirJsonl` against a fixture dir, capability-flag assertions, and `loginInstructions()` string contents. Add `tests/gemini-smoke.test.js` mirroring `tests/copilot-smoke.test.js` — skipped when `probe()` returns false.
5. Extend `tests/provider-registry.test.js` (assert `getProvider('gemini')` returns an adapted instance with `id === 'gemini'` and unknown-provider error lists `gemini`) and `tests/provider-integration.test.js` (add a case stubbing `spawnSync`/`spawn` for `gemini` to verify the adapter's spawn lifecycle emits normalized events and triggers `agents-md-generator` setup/teardown with the `GEMINI.md` filename).

*Model: claude-opus-4-7 (auto → opus) | Effort: auto → max | Tokens: 20 in / 4 775 out (small) | Cache read: 692 900 (medium)*

---

## Coding Agent 1 Response

Reading the copilot provider to mirror its structure.Now I'll create the gemini provider.- Created `src/lib/providers/gemini.js` mirroring exact export shape of `github-copilot.js`: `id`, `capabilities`, `supportsFeature`, `probe`, `loginInstructions`, `spawn` (exported as `spawn` alias so registry adapter resolves it via `mod.spawnCopilot || mod.spawn`), `parseStream`, `cleanupLogDir`, `_parseGeminiLogEntry`, `_readLogDirJsonl`.

- Set `id: 'gemini'`, kept identical `capabilities` object (mcp/tools=true, all runtime features=false).
- `probe()` tries `gemini` binary first, falls back to `gemini.cmd` with `shell:true` on Windows — same pattern as copilot.
- `loginInstructions()` covers `npm i -g @google/gemini-cli`, then `gemini auth` (browser OAuth) or `GEMINI_API_KEY` env var, verify via `gemini --version`.
- Spawn args: `['-p', String(prompt), '--yolo', '--log-dir', logDir]` plus `['--model', model]` when set; both `--yolo` and `--log-dir` support tagged `[NEEDS-VERIFICATION]` in comments since Gemini CLI schema is post-cutoff.

*Model: claude-sonnet-4-6 | Effort: max | Tokens: 9 in / 4 750 out (small) | Cache read: 152 586 (medium)*

---

## Coding Agent 2 Response

Reading relevant files first.Found it in `homestead-exporter-reports`.Now I have full context. Making both changes.Now patch `_adaptModule` to pass `contextFileName: 'GEMINI.md'` when `mod.id === 'gemini'`:Now extend `agents-md-generator.setup()` to honour `contextFileName`:---

- Added `'gemini': () => _adaptModule(require('./gemini'))` to `KNOWN_PROVIDERS` in `registry.js:93`.
- In `_adaptModule` (registry.js), added `const contextFileName = mod.id === 'gemini' ? 'GEMINI.md' : undefined` before the `agentsMdGenerator.setup()` call, then passed `contextFileName` into opts; Copilot path unaffected (resolves to default `'AGENTS.md'`).
- Extended `agents-md-generator.setup()` to destructure `contextFileName = 'AGENTS.md'` from opts, replacing the hardcoded `'AGENTS.md'` string when building `agentsMdPath`; all existing callers continue to work unchanged.
- No changes made to Copilot logic, `_claudeProjectDirName`, `_resolveMemoryMdPaths`, or any other existing behavior.

*Model: claude-sonnet-4-6 | Effort: max | Tokens: 1 920 in / 2 353 out (small) | Cache read: 402 016 (medium)*

---

## Coding Agent 3 Response

Reading `global-config.json` first.- Updated `global-config.json` line 2: appended `| \`gemini\` (standalone \`gemini\` CLI, requires \`GEMINI_API_KEY\` or \`gemini auth\`)`to`// provider` comment string.

- `provider` value (`"claude-code"`) unchanged.
- No other lines touched.

*Model: claude-sonnet-4-6 | Effort: max | Tokens: 6 in / 600 out (tiny) | Cache read: 117 746 (medium)*

---

## Coding Agent 4 Response

Reading existing test files and gemini provider first.Now read the gemini provider that Agent 1 should have created:Now I have everything needed. Writing both test files:Now verify the tests run against the gemini provider:All 30 unit tests pass. Smoke test correctly skips when `probe()` returns false (CLI not installed).

---

- Created `tests/gemini-provider.test.js` with 30 tests covering all `_parseGeminiLogEntry` event kinds (`message`/`assistant`, `tool_call`/`tool_use`/`function_call`, `tool_result`/`tool_response`, `usage`/`token_usage`, `error_quota` from `quota_exceeded`/`rate_limit_exceeded`/quota-error-message, `error`), `_readLogDirJsonl` fixture scenarios (missing dir, valid JSONL, malformed lines, empty lines, multi-file sorted), capability flags, `loginInstructions()` keywords, and full `parseStream` fixture sequences — all 30 pass.
- Created `tests/gemini-smoke.test.js` with 7 smoke tests (GS1–GS6 plus GS1b) mirroring `copilot-smoke.test.js`; exits with `[skip]` immediately when `probe()` returns false so CI never fails on machines without the Gemini CLI installed.

*Model: claude-sonnet-4-6 | Effort: max | Tokens: 16 in / 8 834 out (small) | Cache read: 544 380 (medium)*

---

## Assessment Agent Response

Reading key files to assess the implementation.Based on the git diff and agent responses (actual provider files are new/untracked so not in the diff):

- The `gemini.js` file exists only as an untracked new file — the diff doesn't show it, so key implementation details (`--yolo`, `--log-dir`, JSONL parsing) are unverifiable from the diff alone. Both flags are tagged `[NEEDS-VERIFICATION]` in agent comments, meaning the spawn call may fail entirely on real Gemini CLI.
- **High risk**: `--log-dir` structured JSONL output is a Copilot-specific feature. The real `@google/gemini-cli` likely does not support it, meaning `_readLogDirJsonl` would always read an empty dir and `parseStream` would never emit events. The stdout-fallback path (if any) needs verification.
- **High risk**: `--yolo` auto-approve flag name is unverified. Gemini CLI may use `--auto_approve_everything`, `-y`, or a different flag entirely — wrong flag -> interactive prompt -> process hangs.
- `agents-md-generator.js` backup comment on line ~92 still says `"Back up existing AGENTS.md"` — stale after the `contextFileName` change. Minor doc rot but not a runtime bug.
- `contextFileName` is passed as `undefined` for non-Gemini providers via the ternary `mod.id === 'gemini' ? 'GEMINI.md' : undefined`. The `setup()` default `= 'AGENTS.md'` handles `undefined` correctly, so existing Copilot/Claude-Code paths are unaffected. No regression here.

*Model: claude-sonnet-4-6 | Effort: max | Tokens: 8 in / 2 006 out (small) | Cache read: 194 500 (medium)*

---

## Coding Agent Response (Remediation)

Reading the relevant files first.Now let me check how Gemini provider is called from `registry.js` and how `contextFileName` flows:Now I have the full picture. Fixing 4 issues:

1. `parseStream` has no stdout fallback when `--log-dir` is unsupported (silent empty result)
2. stdout never captured by registry's spawn wrapper
3. Stale comment in `agents-md-generator.js` (line 93)
4. Manual `teardown()` hardcodes `AGENTS.md` ignoring `contextFileName`Now update `parseStream` to accept and use stdout as fallback:Now update `registry.js` to pass stdout to `parseStream`:Fix stale comment and hardcoded `AGENTS.md` in `agents-md-generator.js`:Fix the manual `teardown()` which hardcodes `AGENTS.md`:---

- `gemini.js` `spawn_`: stdout now buffered internally via `child.stdout.on('data', ...)` and exposed through `getStdout()` accessor on the return value.
- `gemini.js` `parseStream`: new 4th param `stdoutBuf`; when `--log-dir` produces zero JSONL entries but stdout has content, emits `assistant_text` event from stdout and returns early — prevents silent empty response when `--log-dir` is unsupported.
- `registry.js` `_adaptModule`: destructures `getStdout` from spawn result, computes `stdoutBuf`, passes it as 4th arg to `mod.parseStream`.
- `agents-md-generator.js`: stale comment on line 93 updated from `AGENTS.md` to `context file`; manual `teardown()` now accepts `contextFileName = 'AGENTS.md'` param and uses it instead of the hardcoded string, matching `setup()`'s behavior.

*Model: claude-sonnet-4-6 | Effort: max | Tokens: 52 in / 8 270 out (small) | Cache read: 864 926 (medium)*
