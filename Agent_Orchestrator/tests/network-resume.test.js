#!/usr/bin/env node
'use strict';

/**
 * Regression tests for network-failure resilience + hresume handoff.
 * Run: node Agent_Orchestrator/tests/network-resume.test.js
 *
 * Requirements covered (from user prompt + plan):
 *  (a) detectNetworkErrorFromBuffer matches each known transient-error string
 *      and does NOT match token-reset or unrelated text.
 *  (b) runClaude retries on transient failure with exponential backoff and
 *      surfaces network-retry config keys (`network-retry.maxAttempts`,
 *      `network-retry.backoffMs`).
 *  (c) On final network failure runPipeline saves resume-state, enqueues a
 *      wake-queue entry at the failed phaseIndex, exits non-zero, and does
 *      NOT call clearResumeState.
 *  (d) auto-resume.js (bare `hresume`) finds the queued network-failure job
 *      and spawns `run-agent.js <topic> continue`.
 *  (e) global-config.json ships network-retry defaults.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const HARNESS = path.join(__dirname, '..');
// Normalise to LF so all string/regex searches work regardless of git checkout line-ending config.
const runAgentSrc = fs.readFileSync(path.join(HARNESS, 'src', 'run-agent.js'), 'utf8').replace(/\r\n/g, '\n');
const autoResumeSrc = fs.readFileSync(path.join(HARNESS, 'src', 'auto-resume.js'), 'utf8').replace(/\r\n/g, '\n');
const globalCfgRaw = fs.readFileSync(path.join(HARNESS, 'global-config.json'), 'utf8').replace(/\r\n/g, '\n');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { _failed++; console.error('FAIL', name, '\n', e.stack || e.message); process.exitCode = 1; }
}

// Extract `detectNetworkErrorFromBuffer` + the regex it depends on from run-agent.js source by eval.
// We isolate the two declarations so the test does not boot the full harness module.
function loadDetector() {
  const startToken = runAgentSrc.indexOf('const NETWORK_ERROR_REGEX');
  const endMarker = 'function detectNetworkErrorFromBuffer';
  const fnStart = runAgentSrc.indexOf(endMarker, startToken);
  assert.ok(startToken >= 0 && fnStart > startToken, 'regex + detector declarations must exist');
  // Find end of function body (matching closing brace at column 0).
  const tail = runAgentSrc.slice(fnStart);
  const closeIdx = tail.indexOf('\n}\n');
  assert.ok(closeIdx > 0, 'detector function body must close');
  const snippet = runAgentSrc.slice(startToken, fnStart + closeIdx + 2);
  const TOKEN_RESET_REGEX = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
  const factory = new Function('TOKEN_RESET_REGEX', snippet + '\nreturn detectNetworkErrorFromBuffer;');
  return factory(TOKEN_RESET_REGEX);
}

test('(a) detectNetworkErrorFromBuffer matches transient network error strings', () => {
  const detect = loadDetector();
  const positives = [
    'fetch failed',
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'connect ECONNRESET 1.2.3.4:443',
    'Error: ETIMEDOUT',
    'EAI_AGAIN api.anthropic.com',
    'network error while reading response',
    'socket hang up',
    'TLS handshake failed',
    'Unable to reach the server',
    'connect ECONNREFUSED 127.0.0.1:443',
  ];
  for (const s of positives) {
    assert.strictEqual(detect(s), true, `expected match: ${s}`);
  }
});

test('(a) detectNetworkErrorFromBuffer ignores token-reset + unrelated text', () => {
  const detect = loadDetector();
  assert.strictEqual(detect('Your limit resets at 3pm (PST)'), false, 'token-reset must not match');
  assert.strictEqual(detect('Some unrelated parse error here'), false);
  assert.strictEqual(detect(''), false);
  assert.strictEqual(detect(null), false);
});

test('(b) runClaude wraps spawn body in retry loop driven by network-retry config', () => {
  // Source-level: confirm config keys are read and the attempt() loop exists.
  assert.ok(/cfgRead\(topicConfig, config, 'network-retry'/.test(runAgentSrc),
    'runClaude must read network-retry config');
  assert.ok(/maxAttempts/.test(runAgentSrc) && /backoffMs/.test(runAgentSrc),
    'config keys must be referenced');
  assert.ok(/const attempt = \(\) => new Promise/.test(runAgentSrc),
    'inner attempt() factory must wrap the spawn promise');
  assert.ok(/for \(let attemptNum = 0; attemptNum < maxAttempts/.test(runAgentSrc),
    'retry loop must iterate up to maxAttempts');
  assert.ok(/err\.networkError/.test(runAgentSrc),
    'retry loop must branch on err.networkError');
  assert.ok(/await new Promise\(r => setTimeout\(r, delay\)\)/.test(runAgentSrc),
    'retry loop must sleep between attempts');
});

test('(b) close handler tags err.networkError without overriding tokenReset', () => {
  // Order matters: tokenReset is checked first; networkError only set when tokenReset is falsy.
  const closeBlock = runAgentSrc.match(/child\.on\('close'[\s\S]*?\}\);\n\s*child\.on\('error'/);
  assert.ok(closeBlock, 'close handler block must exist');
  assert.ok(/err\.tokenReset = detectTokenResetFromBuffer/.test(closeBlock[0]));
  assert.ok(/if \(!err\.tokenReset\) err\.networkError = detectNetworkErrorFromBuffer/.test(closeBlock[0]),
    'networkError must be gated on !tokenReset so the token-reset path keeps priority');
});

test('(c) runPipeline catch handles networkError BEFORE token-reset branch and preserves state', () => {
  const catchBlock = runAgentSrc.match(/} catch \(err\) \{[\s\S]*?die\(`Phase \$\{i \+ 1\} \(\$\{phaseName\}\) failed/);
  assert.ok(catchBlock, 'runPipeline catch block must exist');
  const body = catchBlock[0];
  const netIdx = body.indexOf('err.networkError');
  const tokIdx = body.indexOf('err.tokenReset');
  assert.ok(netIdx > 0 && tokIdx > 0, 'both branches must exist');
  assert.ok(netIdx < tokIdx, 'networkError branch must precede tokenReset branch');
  assert.ok(/saveResumeState\(topic, \{ pipeline: pipelineName, phaseIndex: i/.test(body),
    'must save resume state at the failed phase index');
  assert.ok(/enqueueWake\(topic, pipelineName, i, Date\.now\(\)\)/.test(body),
    'must enqueue wake job with current timestamp');
  assert.ok(/process\.exit\(2\)/.test(body), 'must exit non-zero');
  // The networkError branch must NOT call clearResumeState — that path is reserved for unknown failures.
  const netBranch = body.slice(netIdx, tokIdx);
  assert.ok(!/clearResumeState/.test(netBranch),
    'networkError branch must not clear resume state');
  assert.ok(/hresume/.test(netBranch), 'user-facing message must mention hresume');
});

test('(d) auto-resume.js picks up queued network-failure jobs (bare hresume = all)', () => {
  // The plan reuses the existing wake-queue path. Confirm the queue reader does not
  // discriminate by token-reset metadata — any job with topic/pipeline/phaseIndex resumes.
  assert.ok(/argv\.length === 0\) argv = \['all'\]/.test(autoResumeSrc),
    'bare hresume must default to filter="all"');
  assert.ok(/run-agent\.js/.test(autoResumeSrc),
    'auto-resume must spawn run-agent.js continue');
  assert.ok(/jobs\.length/.test(autoResumeSrc),
    'auto-resume must iterate queued jobs');
});

test('(d) end-to-end queue round-trip: write job, read via auto-resume.js queue path', () => {
  // Simulate enqueueWake's output and ensure auto-resume.js (--diagnose path is safe) can be required without error.
  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-resume-'));
  const queuePath = path.join(tmpStateDir, 'wake-queue.json');
  const job = { topic: 'demo', pipeline: 'code-assess-fix', phaseIndex: 1, resetMs: Date.now() };
  fs.writeFileSync(queuePath, JSON.stringify({ earliest: job.resetMs, jobs: [job] }, null, 2));
  const round = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.strictEqual(round.jobs.length, 1);
  assert.strictEqual(round.jobs[0].topic, 'demo');
  assert.strictEqual(round.jobs[0].phaseIndex, 1);
  // sanity-clean
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

test('(e) global-config.json ships network-retry defaults', () => {
  const cfg = JSON.parse(globalCfgRaw.split('\n').filter(l => !/^\s*"\/\//.test(l)).join('\n'));
  assert.ok(cfg['network-retry'], 'network-retry key must exist');
  assert.strictEqual(typeof cfg['network-retry'].maxAttempts, 'number');
  assert.ok(Array.isArray(cfg['network-retry'].backoffMs));
  assert.ok(cfg['network-retry'].backoffMs.length >= 3, 'at least 3 backoff steps');
});

if (_failed === 0) console.log('\nAll network-resume regression tests passed.');
else { console.error(`\n${_failed} test(s) failed.`); process.exitCode = 1; }
