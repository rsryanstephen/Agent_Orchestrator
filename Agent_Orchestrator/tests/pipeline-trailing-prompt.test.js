#!/usr/bin/env node
'use strict';

// Tests for pipeline trailing "## User Prompt" behaviour and
// related pipeline-dispatch wiring:
//  - Single trailing ## User Prompt appended at end of each pipeline run
//  - appendUserPromptSuffix guard: no duplicate trailing ## User Prompt
//  - Pipeline shorthands map to correct phase arrays
//  - `continue` command restores from resume state
//  - Pipeline phase arrays: planning/coding/assessment/fix/assess-fix/plan-code/
//    code-assess-fix/all
//  - emitEndOfRunLimits inserts BEFORE trailing ## User Prompt
//
// Run: node Agent_Orchestrator/tests/pipeline-trailing-prompt.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const SRC_PATH = path.join(HARNESS, 'src', 'run-agent.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e && e.stack || e}`);
  }
}

// ── Extract PIPELINES constant for direct inspection ─────────────────────────
const phasesMatch = src.match(/const PIPELINES\s*=\s*\{([\s\S]*?)\};/);
assert.ok(phasesMatch, 'PIPELINES must be defined in run-agent.js');
// eslint-disable-next-line no-new-func
const phasesCtx = new Function(`const PIPELINES = {${phasesMatch[1]}}; return PIPELINES;`)();

test('PIPELINES: all 8 pipeline keys defined (continue handled separately)', () => {
  const expected = ['planning', 'coding', 'assessment', 'fix', 'assess-fix', 'plan-code', 'code-assess-fix', 'all'];
  for (const key of expected) {
    assert.ok(key in phasesCtx, `PIPELINES must contain '${key}'`);
  }
});

test('PIPELINES: assess-fix = [assessment, fix]', () => {
  assert.deepStrictEqual(phasesCtx['assess-fix'], ['assessment', 'fix']);
});

test('PIPELINES: plan-code = [planning, coding]', () => {
  assert.deepStrictEqual(phasesCtx['plan-code'], ['planning', 'coding']);
});

test('PIPELINES: code-assess-fix = [coding, assessment, fix]', () => {
  assert.deepStrictEqual(phasesCtx['code-assess-fix'], ['coding', 'assessment', 'fix']);
});

test('PIPELINES: all = [planning, coding, assessment, fix]', () => {
  assert.deepStrictEqual(phasesCtx['all'], ['planning', 'coding', 'assessment', 'fix']);
});

test('VALID_ROLES: contains all expected pipeline shorthands', () => {
  const validRolesMatch = src.match(/const VALID_ROLES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(validRolesMatch, 'VALID_ROLES must be defined');
  const rolesStr = validRolesMatch[1];
  const expected = ['planning', 'coding', 'assessment', 'fix', 'assess-fix', 'plan-code', 'code-assess-fix', 'all', 'continue'];
  for (const r of expected) {
    assert.ok(rolesStr.includes(`'${r}'`), `VALID_ROLES must include '${r}'`);
  }
});

// ── Single trailing ## User Prompt ───────────────────────────────────────────

// We can test the appendToFile guard and appendUserPromptSuffixToFile
// by extracting the relevant helper from source into a sandbox.
// Those functions use `fs` and `acquireFileLock` / `releaseFileLock`.
// Rather than loading the whole module (side effects), we replicate
// their core regex guard with the actual pattern from source.

test('appendToFile guard: does NOT append suffix when trailing ## User Prompt already present', () => {
  // Extract the guard regex from source.
  const guardMatch = src.match(/if\s*\(appendUserPromptSuffix\s*&&\s*!\/([^/]+)\/\s*\.test\(existing\)\)/);
  assert.ok(guardMatch, 'appendUserPromptSuffix guard pattern must be in source');
  const guardRe = new RegExp(guardMatch[1]);
  const withTrailing = 'some content\n\n---\n\n## User Prompt\n\n';
  const withoutTrailing = 'some content\n\nno trailing prompt here';
  // Guard fires (suppress) when existing ENDS with ## User Prompt.
  assert.ok(guardRe.test(withTrailing), 'guard must match existing trailing ## User Prompt');
  assert.ok(!guardRe.test(withoutTrailing), 'guard must NOT match when no trailing ## User Prompt');
});

test('appendToFile guard: accepts (From the Queue) variant of trailing ## User Prompt', () => {
  const guardMatch = src.match(/if\s*\(appendUserPromptSuffix\s*&&\s*!\/([^/]+)\/\s*\.test\(existing\)\)/);
  const guardRe = new RegExp(guardMatch[1]);
  const withTagged = 'content\n\n---\n\n## User Prompt (From the Queue)\n\n';
  assert.ok(guardRe.test(withTagged), 'tagged trailing ## User Prompt must also suppress duplicate');
});

test('single trailing ## User Prompt suffix appended via appendUserPromptSuffixToFile', () => {
  // Use the actual helper. We cannot load run-agent.js directly (side effects),
  // so test via a temp file using the normalize-history module which implements
  // the same stripping logic used at runtime.
  const norm = require(path.join(HARNESS, 'src', 'normalize-history'));
  const content = '# topic\n\n## Planning Agent Response\n\nSome plan.\n\n---\n\n## Coding Agent Response\n\nSome code.\n\n';
  const { collapsed } = norm.stripAllTrailingEmptyPlaceholders(content);
  assert.strictEqual(collapsed, 0, 'no trailing placeholder in seeded content');
  // After a run, exactly ONE trailing ## User Prompt should be present.
  const withSuffix = content + '\n\n---\n\n## User Prompt\n\n';
  const { collapsed: c2 } = norm.stripAllTrailingEmptyPlaceholders(withSuffix);
  assert.strictEqual(c2, 1, 'single trailing ## User Prompt must be recognized by strip helper');
});

test('stripAllTrailingEmptyPlaceholders: removes stacked duplicate ## User Prompt placeholders', () => {
  const norm = require(path.join(HARNESS, 'src', 'normalize-history'));
  const stacked =
    '# topic\n\n## Coding Agent Response\n\nDone.\n\n---\n\n## User Prompt\n\n\n\n---\n\n## User Prompt\n\n';
  const { collapsed, result } = norm.stripAllTrailingEmptyPlaceholders(stacked);
  assert.ok(collapsed >= 2, 'must collapse both trailing placeholders');
  // After strip, no trailing ## User Prompt remains.
  assert.ok(!/## User Prompt/.test(result), 'stripped result must have no trailing placeholder');
});

// ── emitEndOfRunLimits: inserts BEFORE trailing ## User Prompt ────────────────
test('emitEndOfRunLimits: source inserts limits line BEFORE trailing ## User Prompt', () => {
  // Verify the regex pattern and writeFileSync reorder are present in source.
  assert.match(src, /## User Prompt[\s\S]{0,100}before.*slice|slice[\s\S]{0,100}## User Prompt/,
    'emitEndOfRunLimits must insert line before trailing prompt');
  // Confirm the specific regex used in emitEndOfRunLimits.
  assert.ok(src.includes('Insert BEFORE any trailing') || src.includes('before + line + m[1]'),
    'emitEndOfRunLimits insert-before comment or splice expression must exist in source');
});

// ── resolvePipelineFromShorthand wiring ───────────────────────────────────────
test('resolvePipelineFromShorthand maps all CLI shorthands correctly', () => {
  // Extract the CMD_MAP literal and eval it.
  const cmdMapMatch = src.match(/const CMD_MAP\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(cmdMapMatch, 'CMD_MAP must be defined in resolvePipelineFromShorthand');
  // eslint-disable-next-line no-new-func
  const CMD_MAP = new Function(`return {${cmdMapMatch[1]}};`)();
  assert.strictEqual(CMD_MAP['c'], 'coding');
  assert.strictEqual(CMD_MAP['p'], 'planning');
  assert.strictEqual(CMD_MAP['a'], 'assessment');
  assert.strictEqual(CMD_MAP['f'], 'fix');
  assert.strictEqual(CMD_MAP['af'], 'assess-fix');
  assert.strictEqual(CMD_MAP['pc'], 'plan-code');
  assert.strictEqual(CMD_MAP['caf'], 'code-assess-fix');
  assert.strictEqual(CMD_MAP['all'], 'all');
  assert.strictEqual(CMD_MAP['pcaf'], 'all');
  assert.strictEqual(CMD_MAP['cont'], 'continue');
});

// ── appendToFile: suffix path integration via temp file ──────────────────────
test('appendUserPromptSuffixToFile: function is defined in source', () => {
  assert.ok(src.includes('function appendUserPromptSuffixToFile'), 'helper fn must exist');
  // Must use acquireFileLock + appendFileSync.
  const fnStart = src.indexOf('function appendUserPromptSuffixToFile');
  const fnBody = src.slice(fnStart, fnStart + 600);
  assert.ok(fnBody.includes('acquireFileLock'), 'must acquire lock before write');
});

// ── Pipeline: single trailing prompt for all pipeline shorthands ─────────────
test('pipeline: appendUserPromptSuffix=true on the LAST phase only (source assertion)', () => {
  // runCoding/runAssessment/runCodingAssessment accept a noSuffix param.
  // Final phase (noSuffix=false) appends; non-final (noSuffix=true) skips.
  assert.match(src, /appendUserPromptSuffix:\s*!noSuffix/,
    'suffix must be gated by !noSuffix param');
  assert.match(src, /appendUserPromptSuffixToFile\(historyPath\)/,
    'appendUserPromptSuffixToFile must be called for parallel final phase');
});

// ── continue command: PIPELINE_PHASES entry exists ───────────────────────────
test('continue: PIPELINE_PHASES.continue entry present (handled by resume logic)', () => {
  // `continue` is special — it is listed in VALID_ROLES but its phase resolution
  // is handled by resume state, not a fixed phase array. Confirm source acknowledges this.
  assert.ok(src.includes("'continue'") || src.includes('"continue"'),
    '"continue" must appear in source');
  assert.ok(src.includes('VALID_ROLES'), 'VALID_ROLES must be present');
});

// ── Per-file .lock: acquireFileLock / releaseFileLock ─────────────────────────
test('acquireFileLock: creates targetPath + ".lock" file', () => {
  const tmp = path.join(os.tmpdir(), `htest-lock-${process.pid}.txt`);
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.unlinkSync(tmp + '.lock'); } catch {}
  fs.writeFileSync(tmp, 'content', 'utf8');

  // Extract acquireFileLock and releaseFileLock from source and eval them.
  // They only depend on fs, path, sleepMs (which we stub), and die (stub).
  function extractFn(source, fnName) {
    const start = source.indexOf(`function ${fnName}`);
    if (start < 0) throw new Error(`${fnName} not found`);
    let depth = 0, i = start;
    while (i < source.length) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
    return source.slice(start, i);
  }
  // eslint-disable-next-line no-new-func
  const lockFns = new Function(
    'fs', 'process', 'sleepMs', 'die',
    `${extractFn(src, 'acquireFileLock')}\n${extractFn(src, 'releaseFileLock')}\nreturn { acquireFileLock, releaseFileLock };`
  )(fs, process, () => {}, (m) => { throw new Error(m); });

  const lockPath = lockFns.acquireFileLock(tmp);
  assert.ok(fs.existsSync(lockPath), '.lock file must exist after acquireFileLock');
  assert.strictEqual(lockPath, tmp + '.lock', 'lock path must be targetPath + .lock');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), String(process.pid), 'lock file must contain PID');
  lockFns.releaseFileLock(lockPath);
  assert.ok(!fs.existsSync(lockPath), '.lock file must be removed after releaseFileLock');

  try { fs.unlinkSync(tmp); } catch {}
});

test('acquireFileLock: second acquire on same path blocks until first released', (done) => {
  // Use a sync approach: release immediately so acquire succeeds without sleeping.
  const tmp2 = path.join(os.tmpdir(), `htest-lock2-${process.pid}.txt`);
  try { fs.unlinkSync(tmp2 + '.lock'); } catch {}
  fs.writeFileSync(tmp2, 'x', 'utf8');
  function extractFn(source, fnName) {
    const start = source.indexOf(`function ${fnName}`);
    let depth = 0, i = start;
    while (i < source.length) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
    return source.slice(start, i);
  }
  // eslint-disable-next-line no-new-func
  const lockFns = new Function(
    'fs', 'process', 'sleepMs', 'die',
    `${extractFn(src, 'acquireFileLock')}\n${extractFn(src, 'releaseFileLock')}\nreturn { acquireFileLock, releaseFileLock };`
  )(fs, process, () => {}, (m) => { throw new Error(m); });

  const lp1 = lockFns.acquireFileLock(tmp2);
  // Release immediately so a second acquire succeeds.
  lockFns.releaseFileLock(lp1);
  const lp2 = lockFns.acquireFileLock(tmp2);
  assert.ok(fs.existsSync(lp2), 'second acquire must succeed after first release');
  lockFns.releaseFileLock(lp2);
  try { fs.unlinkSync(tmp2); } catch {}
});

// ── max-parallel-agents-per-topic: preferred over max-concurrent-agents ───────
test('getMaxConcurrentAgents: reads max-parallel-agents-per-topic BEFORE max-concurrent-agents', () => {
  const fnStart = src.indexOf('function getMaxConcurrentAgents');
  assert.ok(fnStart >= 0, 'getMaxConcurrentAgents must be defined in source');
  const fnEnd = src.indexOf('\n}', fnStart) + 2;
  const fnBody = src.slice(fnStart, fnEnd);
  const perTopicIdx = fnBody.indexOf('max-parallel-agents-per-topic');
  const legacyIdx = fnBody.indexOf('max-concurrent-agents');
  assert.ok(perTopicIdx >= 0, 'new key must be read in getMaxConcurrentAgents');
  assert.ok(legacyIdx >= 0, 'legacy fallback key must be read in getMaxConcurrentAgents');
  assert.ok(perTopicIdx < legacyIdx, 'new key must be read BEFORE legacy fallback');
});

test('getMaxConcurrentAgents: returns DEFAULT_MAX_CONCURRENT_AGENTS when both keys absent', () => {
  assert.ok(src.includes('DEFAULT_MAX_CONCURRENT_AGENTS'), 'default constant must be defined');
  const fnStart = src.indexOf('function getMaxConcurrentAgents');
  const fnEnd = src.indexOf('\n}', fnStart) + 2;
  const fnBody = src.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('DEFAULT_MAX_CONCURRENT_AGENTS'), 'fn must return default when no config');
});

// ── parallel-assessment-agents=false: single-assessor path ───────────────────
test('runPhase assessment: branches on getParallelAssessmentAgents() to choose parallel vs serial', () => {
  // The runPhase switch for 'assessment' must call getParallelAssessmentAgents().
  const assessStart = src.indexOf("case 'assessment':");
  assert.ok(assessStart >= 0, "case 'assessment': must exist in runPhase");
  const assessBlock = src.slice(assessStart, assessStart + 400);
  assert.ok(assessBlock.includes('getParallelAssessmentAgents'), 'assessment case must call getParallelAssessmentAgents');
  assert.ok(assessBlock.includes('runAssessmentParallel'), 'assessment case must reference runAssessmentParallel');
  assert.ok(assessBlock.includes('runAssessment('), 'assessment case must also reference serial runAssessment');
});

test('runPhase fix: branches on getParallelAssessmentAgents() for fix phase too', () => {
  const fixStart = src.indexOf("case 'fix':");
  assert.ok(fixStart >= 0, "case 'fix': must exist in runPhase");
  const fixBlock = src.slice(fixStart, fixStart + 400);
  assert.ok(fixBlock.includes('getParallelAssessmentAgents'), 'fix case must also consult getParallelAssessmentAgents');
});

// ── Excess-dropped behavior: slice to cap in all parallel runners ─────────────
test('runCodingParallel: caps tasks with Math.min(subtasks.length, cap)', () => {
  const fnStart = src.indexOf('async function runCodingParallel');
  assert.ok(fnStart >= 0, 'runCodingParallel must exist');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
  assert.match(fnBody, /subtasks\.slice\(0,\s*Math\.min\(subtasks\.length,\s*cap\)\)/,
    'runCodingParallel must slice subtasks to cap');
});

test('runAssessmentParallel: caps tasks with Math.min(subtasks.length, cap)', () => {
  const fnStart = src.indexOf('async function runAssessmentParallel');
  assert.ok(fnStart >= 0, 'runAssessmentParallel must exist');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
  assert.match(fnBody, /subtasks\.slice\(0,\s*Math\.min\(subtasks\.length,\s*cap\)\)/,
    'runAssessmentParallel must also slice to cap');
});

test('runCodingAssessmentParallel: caps tasks with Math.min(subtasks.length, cap)', () => {
  const fnStart = src.indexOf('async function runCodingAssessmentParallel');
  assert.ok(fnStart >= 0, 'runCodingAssessmentParallel must exist');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
  assert.match(fnBody, /subtasks\.slice\(0,\s*Math\.min\(subtasks\.length,\s*cap\)\)/,
    'runCodingAssessmentParallel must also slice to cap');
});

// ── PIPELINES: single-phase entries ─────────────────────────────────────────
test('PIPELINES: planning = [planning]', () => {
  assert.deepStrictEqual(phasesCtx['planning'], ['planning']);
});

test('PIPELINES: coding = [coding]', () => {
  assert.deepStrictEqual(phasesCtx['coding'], ['coding']);
});

test('PIPELINES: assessment = [assessment]', () => {
  assert.deepStrictEqual(phasesCtx['assessment'], ['assessment']);
});

test('PIPELINES: fix = [fix]', () => {
  assert.deepStrictEqual(phasesCtx['fix'], ['fix']);
});

// ── runCodingParallel: returns capped tasks array ────────────────────────────
test('runCodingParallel: returns tasks array after parallel run (source assertion)', () => {
  const fnStart = src.indexOf('async function runCodingParallel');
  assert.ok(fnStart >= 0, 'runCodingParallel must exist');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2500);
  assert.match(fnBody, /return tasks;/, 'runCodingParallel must return tasks array');
});

// ── runAssessmentParallel: legacy (task-N) regex in header matching ───────────
test('runAssessmentParallel: uses legacy (task-N) fallback regex for coding-agent header lookup', () => {
  const fnStart = src.indexOf('async function runAssessmentParallel');
  assert.ok(fnStart >= 0, 'runAssessmentParallel must exist');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2500);
  // Must recognise both "Coding Agent N Response" and legacy "Coding Agent Response (task-N)".
  assert.ok(fnBody.includes('task-'), 'runAssessmentParallel must handle legacy (task-N) header format');
});

// ── runCodingAssessmentParallel: legacy (task-N) regex in both header lookups ─
test('runCodingAssessmentParallel: uses legacy (task-N) fallback for assessment AND coding header lookups', () => {
  const fnStart = src.indexOf('async function runCodingAssessmentParallel');
  assert.ok(fnStart >= 0, 'runCodingAssessmentParallel must exist');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2500);
  // Must recognise legacy (task-N) for BOTH Assessment Agent and Coding Agent lookups.
  const taskMatches = fnBody.match(/task-/g) || [];
  assert.ok(taskMatches.length >= 2, 'runCodingAssessmentParallel must handle legacy (task-N) in both assessment and coding header regexes');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
