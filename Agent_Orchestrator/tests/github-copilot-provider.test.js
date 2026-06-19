#!/usr/bin/env node
'use strict';

// Unit tests for github-copilot.js provider + agents-md-generator.js.
// Run: node Agent_Orchestrator/tests/github-copilot-provider.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HARNESS = path.join(__dirname, '..');
const provider = require('../src/lib/providers/github-copilot');
const generator = require('../src/lib/providers/agents-md-generator');

let _failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '\n', e.stack || e.message); _failed++; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
}

function writeJsonl(dir, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dir, 'run.jsonl'), lines + '\n', 'utf8');
}

// ── Capabilities ───────────────────────────────────────────────────────────────

test('capabilities: MCP + tools enabled, all others disabled', () => {
  assert.strictEqual(provider.capabilities.mcp, true);
  assert.strictEqual(provider.capabilities.tools, true);
  assert.strictEqual(provider.capabilities.planMode, false);
  assert.strictEqual(provider.capabilities.skillsRuntime, false);
  assert.strictEqual(provider.capabilities.subAgents, false);
  assert.strictEqual(provider.capabilities.autoResume, false);
  assert.strictEqual(provider.capabilities.streamJson, false);
  assert.strictEqual(provider.capabilities.hooks, false);
  assert.strictEqual(provider.capabilities.permissionMode, false);
});

test('supportsFeature: mcp=true, autoResume=false', () => {
  assert.strictEqual(provider.supportsFeature('mcp'), true);
  assert.strictEqual(provider.supportsFeature('autoResume'), false);
  assert.strictEqual(provider.supportsFeature('nonexistent'), false);
});

// ── loginInstructions ─────────────────────────────────────────────────────────

test('loginInstructions contains expected keywords', () => {
  const s = provider.loginInstructions();
  assert.ok(typeof s === 'string', 'must be string');
  assert.ok(s.includes('copilot auth login'), 'must mention copilot auth login');
  assert.ok(s.includes('copilot --version'), 'must mention verification command');
  assert.ok(s.includes('~/.copilot/'), 'must mention auth persist path');
  assert.ok(s.includes('300'), 'must mention Pro quota');
  assert.ok(s.includes('1500'), 'must mention Business quota');
  assert.ok(/DO NOT use ['`]gh copilot['`]/i.test(s), 'must warn against gh copilot');
});

// ── parseCopilotLogEntry (schema isolation fn) ─────────────────────────────────

const parse = provider._parseCopilotLogEntry;

test('parseCopilotLogEntry: null/empty input returns null', () => {
  assert.strictEqual(parse(null), null);
  assert.strictEqual(parse({}), null);
  assert.strictEqual(parse({ type: 'unknown_xyz' }), null);
});

test('parseCopilotLogEntry: assistant_text from type=message', () => {
  const r = parse({ type: 'message', text: 'Hello world' });
  assert.strictEqual(r.kind, 'assistant_text');
  assert.strictEqual(r.text, 'Hello world');
});

test('parseCopilotLogEntry: assistant_text from type=assistant', () => {
  const r = parse({ type: 'assistant', content: 'Plan complete.' });
  assert.strictEqual(r.kind, 'assistant_text');
  assert.strictEqual(r.text, 'Plan complete.');
});

test('parseCopilotLogEntry: tool_call', () => {
  const r = parse({ type: 'tool_call', id: 't1', name: 'Read', input: { file_path: '/foo.txt' } });
  assert.strictEqual(r.kind, 'tool_call');
  assert.strictEqual(r.id, 't1');
  assert.strictEqual(r.name, 'Read');
  assert.deepStrictEqual(r.input, { file_path: '/foo.txt' });
});

test('parseCopilotLogEntry: tool_result', () => {
  const r = parse({ type: 'tool_result', call_id: 't1', output: 'line1\nline2', is_error: false });
  assert.strictEqual(r.kind, 'tool_result');
  assert.strictEqual(r.call_id, 't1');
  assert.strictEqual(r.output, 'line1\nline2');
  assert.strictEqual(r.is_error, false);
});

test('parseCopilotLogEntry: tool_result truncates at 64KB', () => {
  const bigOutput = 'x'.repeat(70000);
  const r = parse({ type: 'tool_result', output: bigOutput });
  assert.ok(r.output.endsWith('[TRUNCATED]'), 'must append [TRUNCATED]');
  assert.ok(r.output.length <= 65536 + '[TRUNCATED]'.length);
});

test('parseCopilotLogEntry: usage', () => {
  const r = parse({ type: 'usage', input_tokens: 100, output_tokens: 50 });
  assert.strictEqual(r.kind, 'usage');
  assert.strictEqual(r.input_tokens, 100);
  assert.strictEqual(r.output_tokens, 50);
});

test('parseCopilotLogEntry: quota_exceeded', () => {
  const r = parse({ type: 'quota_exceeded', message: 'Quota reached' });
  assert.strictEqual(r.kind, 'error_quota');
  assert.ok(r.message.includes('Quota reached'));
});

test('parseCopilotLogEntry: error with auth 401', () => {
  const r = parse({ type: 'error', message: '401 unauthorized' });
  assert.strictEqual(r.kind, 'error');
  assert.strictEqual(r.code, 'error_auth');
});

// ── parseStream (full JSONL fixture) ──────────────────────────────────────────

test('parseStream: full JSONL fixture -> expected event sequence', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'message', text: 'Analyzing your request...' },
      { type: 'tool_call', id: 'tc1', name: 'Read', input: { file_path: '/src/foo.js' } },
      { type: 'tool_result', call_id: 'tc1', output: 'const x = 1;', is_error: false },
      { type: 'message', text: 'Done. Here is the fix.' },
      { type: 'usage', input_tokens: 200, output_tokens: 80 },
    ]);

    const events = provider.parseStream(0, tmpDir, '');
    const types = events.map(e => e.type);

    assert.ok(types.includes('assistant_text'), 'must have assistant_text');
    assert.ok(types.includes('tool_call'), 'must have tool_call');
    assert.ok(types.includes('tool_result'), 'must have tool_result');
    assert.ok(types.includes('usage'), 'must have usage');
    assert.ok(types.includes('done'), 'must have done');

    const textEvents = events.filter(e => e.type === 'assistant_text');
    assert.strictEqual(textEvents.length, 2, 'two text messages');
    assert.strictEqual(textEvents[0].content.text, 'Analyzing your request...');
    assert.strictEqual(textEvents[1].content.text, 'Done. Here is the fix.');

    const toolCall = events.find(e => e.type === 'tool_call');
    assert.strictEqual(toolCall.content.id, 'tc1');
    assert.strictEqual(toolCall.content.name, 'Read');
    assert.deepStrictEqual(toolCall.content.input, { file_path: '/src/foo.js' });

    const toolResult = events.find(e => e.type === 'tool_result');
    assert.strictEqual(toolResult.content.call_id, 'tc1');
    assert.strictEqual(toolResult.content.output, 'const x = 1;');
    assert.strictEqual(toolResult.content.is_error, false);

    const usageEvent = events.find(e => e.type === 'usage');
    assert.strictEqual(usageEvent.content.input_tokens, 200);
    assert.strictEqual(usageEvent.content.output_tokens, 80);
    assert.strictEqual(usageEvent.content.cache_read_tokens, null);
    assert.strictEqual(usageEvent.content.cache_write_tokens, null);
    assert.strictEqual(usageEvent.content.cost_usd, null);

    const doneEvent = events.find(e => e.type === 'done');
    assert.strictEqual(doneEvent.content.exit_code, 0);
    assert.strictEqual(doneEvent.content.session_id, null);

    // done must be last
    assert.strictEqual(types[types.length - 1], 'done', 'done must be last event');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('parseStream: non-zero exit + no log dir -> error + done', () => {
  const events = provider.parseStream(1, '/nonexistent-dir-xyz', 'spawn failed: ENOENT');
  assert.ok(events.some(e => e.type === 'error'), 'must have error');
  assert.ok(events.some(e => e.type === 'done'), 'must have done');
  const err = events.find(e => e.type === 'error');
  assert.strictEqual(err.content.code, 'error_spawn');
});

test('parseStream: quota_exceeded entry -> error_quota event', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'message', text: 'Working...' },
      { type: 'quota_exceeded', message: 'Premium request quota exhausted' },
    ]);
    const events = provider.parseStream(1, tmpDir, '');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, 'must have error event');
    assert.strictEqual(err.content.code, 'error_quota');
    assert.strictEqual(events[events.length - 1].type, 'done');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('parseStream: stderr quota -> type:error with code:error_quota (not type:error_quota)', () => {
  // Regression: stderr-fallback quota path must use type:'error', not type:'error_quota',
  // so downstream consumers only need to branch on e.type === 'error'.
  // Use a real (empty) logDir so parseStream does not take the early spawn-failure path.
  const tmpDir = makeTmpDir();
  try {
    const events = provider.parseStream(1, tmpDir, 'Premium request quota exhausted');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, 'must have type:error event for stderr quota');
    assert.strictEqual(err.content.code, 'error_quota');
    assert.ok(!events.some(e => e.type === 'error_quota'), 'must NOT emit type:error_quota');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('parseStream: all events have ts field (number)', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [{ type: 'message', text: 'Hi' }]);
    const events = provider.parseStream(0, tmpDir, '');
    for (const e of events) {
      assert.ok(typeof e.ts === 'number', `event ${e.type} missing numeric ts`);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── extractRateLimitFields (via parseCopilotLogEntry) ─────────────────────────

test('parseCopilotLogEntry: usage with x-ratelimit headers via entry.headers', () => {
  const r = parse({
    type: 'usage',
    input_tokens: 10,
    output_tokens: 5,
    headers: {
      'x-ratelimit-limit-requests': '300',
      'x-ratelimit-remaining-requests': '297',
    },
  });
  assert.strictEqual(r.kind, 'usage');
  assert.ok(r.ratelimit !== null, 'ratelimit must not be null');
  assert.strictEqual(r.ratelimit['x-ratelimit-limit-requests'], '300');
  assert.strictEqual(r.ratelimit['x-ratelimit-remaining-requests'], '297');
});

test('parseCopilotLogEntry: usage with x-ratelimit headers via entry.ratelimit_headers', () => {
  const r = parse({
    type: 'usage',
    input_tokens: 10,
    output_tokens: 5,
    ratelimit_headers: { 'x-ratelimit-limit-tokens': '50000' },
  });
  assert.ok(r.ratelimit !== null, 'ratelimit must not be null');
  assert.strictEqual(r.ratelimit['x-ratelimit-limit-tokens'], '50000');
});

test('parseCopilotLogEntry: usage with no ratelimit headers returns null ratelimit', () => {
  const r = parse({ type: 'usage', input_tokens: 10, output_tokens: 5 });
  assert.strictEqual(r.ratelimit, null);
});

test('parseCopilotLogEntry: quota_exceeded with ratelimit headers', () => {
  const r = parse({
    type: 'quota_exceeded',
    message: 'Premium request quota exhausted',
    headers: { 'x-ratelimit-reset-requests': '2026-07-01T00:00:00Z' },
  });
  assert.strictEqual(r.kind, 'error_quota');
  assert.ok(r.ratelimit !== null, 'ratelimit must propagate');
  assert.strictEqual(r.ratelimit['x-ratelimit-reset-requests'], '2026-07-01T00:00:00Z');
});

test('parseCopilotLogEntry: type=rate_limit_exceeded maps to error_quota', () => {
  const r = parse({ type: 'rate_limit_exceeded', message: 'Rate limit hit' });
  assert.strictEqual(r.kind, 'error_quota');
  assert.ok(r.message.includes('Rate limit hit'));
});

test('parseCopilotLogEntry: type=error_quota maps to error_quota', () => {
  const r = parse({ type: 'error_quota', message: 'quota gone' });
  assert.strictEqual(r.kind, 'error_quota');
});

test('parseCopilotLogEntry: type=error with premium pattern in message maps to error_quota', () => {
  const r = parse({ type: 'error', message: 'premium request limit reached' });
  assert.strictEqual(r.kind, 'error_quota');
});

test('parseStream: ratelimit headers in usage entry bubble into usage event meta', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'message', text: 'done' },
      {
        type: 'usage',
        input_tokens: 50,
        output_tokens: 20,
        headers: { 'x-ratelimit-remaining-requests': '299' },
      },
    ]);
    const events = provider.parseStream(0, tmpDir, '');
    const usageEvent = events.find(e => e.type === 'usage');
    assert.ok(usageEvent, 'must have usage event');
    assert.ok(usageEvent.meta, 'must have meta when ratelimit present');
    assert.ok(usageEvent.meta.ratelimit_headers, 'must have ratelimit_headers in meta');
    assert.strictEqual(
      usageEvent.meta.ratelimit_headers['x-ratelimit-remaining-requests'],
      '299'
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('parseStream: quota_exceeded with ratelimit headers -> error event with meta.ratelimit_headers', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'message', text: 'Working...' },
      {
        type: 'quota_exceeded',
        message: 'Premium request quota exhausted',
        headers: { 'x-ratelimit-reset-requests': '2026-07-01T00:00:00Z' },
      },
    ]);
    const events = provider.parseStream(1, tmpDir, '');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, 'must have error event');
    assert.strictEqual(err.content.code, 'error_quota');
    assert.ok(err.meta, 'must have meta when ratelimit headers present');
    assert.strictEqual(
      err.meta.ratelimit_headers['x-ratelimit-reset-requests'],
      '2026-07-01T00:00:00Z'
    );
    assert.strictEqual(events[events.length - 1].type, 'done');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── spawnCopilot: heartbeat + hook registry ────────────────────────────────────

const { EventEmitter } = require('events');

function makeFakeChild() {
  const ee = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  return ee;
}

test('spawnCopilot: heartbeat registered at 5000ms interval', () => {
  provider._clearHooks();
  const intervals = [];
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;

  global.setInterval = (fn, delay) => {
    const id = Symbol('interval');
    intervals.push({ fn, delay, id, cleared: false });
    return id;
  };
  global.clearInterval = (id) => {
    const entry = intervals.find(i => i.id === id);
    if (entry) entry.cleared = true;
  };

  const fakeChild = makeFakeChild();
  const { waitForExit } = provider.spawnCopilot({ prompt: 'test', _spawn: () => fakeChild });

  // Verify registration before restoring globals.
  assert.strictEqual(intervals.length, 1, 'one heartbeat interval registered');
  assert.strictEqual(intervals[0].delay, 5000, 'interval period is 5000ms');

  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data) => { lines.push(String(data)); return true; };
  intervals[0].fn();
  process.stdout.write = origWrite;

  assert.ok(lines.some(l => /^still working\.\.\. \(\d+s\)\n$/.test(l)), 'heartbeat message matches expected format');

  // Emit close while fake clearInterval still active so _runPostHooks() hits our tracker.
  waitForExit();
  fakeChild.emit('close', 0); // synchronous — _runPostHooks fires here, calls fake clearInterval

  // Restore AFTER emit.
  global.setInterval = origSetInterval;
  global.clearInterval = origClearInterval;

  assert.ok(intervals[0].cleared, 'interval cleared after child closes');
  provider._clearHooks();
});

test('spawnCopilot: pre-hooks fire before spawn, post-hooks fire after close', () => {
  provider._clearHooks();
  const order = [];

  provider.registerHook('pre', () => order.push('pre'));
  provider.registerHook('post', () => order.push('post'));

  const fakeChild = makeFakeChild();
  const { waitForExit } = provider.spawnCopilot({
    prompt: 'test',
    _spawn: (..._args) => { order.push('spawn'); return fakeChild; },
  });

  assert.deepStrictEqual(order.slice(0, 2), ['pre', 'spawn'], 'pre fires before spawn');

  waitForExit();
  fakeChild.emit('close', 0);

  assert.ok(order.includes('post'), 'post hook fired');
  assert.strictEqual(order[order.length - 1], 'post', 'post is last in order');
  assert.deepStrictEqual(order, ['pre', 'spawn', 'post'], 'full order: pre -> spawn -> post');

  provider._clearHooks();
});

test('spawnCopilot: post-hooks fire on child error too', () => {
  provider._clearHooks();
  const fired = [];
  provider.registerHook('post', () => fired.push('post'));

  const fakeChild = makeFakeChild();
  const { waitForExit } = provider.spawnCopilot({ prompt: 'test', _spawn: () => fakeChild });
  waitForExit();
  fakeChild.emit('error', new Error('spawn failed'));

  assert.ok(fired.includes('post'), 'post hook fires on child error');
  provider._clearHooks();
});

// ── agents-md-generator ────────────────────────────────────────────────────────

test('agents-md-generator: generates AGENTS.md from CLAUDE.md + MEMORY.md', () => {
  const rootDir = makeTmpDir();
  const claudeDir = makeTmpDir();
  const memDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# Global Rules\nBe terse.', 'utf8');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Memory\nUser prefers short answers.', 'utf8');

    const teardown = generator.setup({
      rootDir,
      claudeMdPaths: [path.join(claudeDir, 'CLAUDE.md')],
      memoryMdPaths: [path.join(memDir, 'MEMORY.md')],
    });

    const agentsMd = fs.readFileSync(path.join(rootDir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('Be terse.'), 'must include CLAUDE.md content');
    assert.ok(agentsMd.includes('short answers'), 'must include MEMORY.md content');

    teardown();
    assert.ok(!fs.existsSync(path.join(rootDir, 'AGENTS.md')), 'AGENTS.md removed after teardown');
  } finally {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(memDir, { recursive: true, force: true }); } catch {}
  }
});

test('agents-md-generator: backs up existing AGENTS.md', () => {
  const rootDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(rootDir, 'AGENTS.md'), '# Original content', 'utf8');

    const teardown = generator.setup({
      rootDir,
      claudeMdPaths: [],
      memoryMdPaths: [],
    });

    assert.ok(
      fs.existsSync(path.join(rootDir, 'AGENTS.md.harness-bak')),
      'backup must exist during run'
    );

    teardown();
    const restored = fs.readFileSync(path.join(rootDir, 'AGENTS.md'), 'utf8');
    assert.strictEqual(restored, '# Original content', 'original content restored');
    assert.ok(!fs.existsSync(path.join(rootDir, 'AGENTS.md.harness-bak')), 'backup removed after teardown');
  } finally {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch {}
  }
});

test('agents-md-generator: teardown(rootDir) is idempotent', () => {
  const rootDir = makeTmpDir();
  try {
    generator.teardown(rootDir);
    generator.teardown(rootDir);
    // No throw = pass
  } finally {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch {}
  }
});

test('agents-md-generator: absent source files produce empty AGENTS.md (no crash)', () => {
  const rootDir = makeTmpDir();
  try {
    const teardown = generator.setup({
      rootDir,
      claudeMdPaths: ['/nonexistent/CLAUDE.md'],
      memoryMdPaths: ['/nonexistent/MEMORY.md'],
    });
    // No AGENTS.md written if no content, but no crash.
    teardown();
  } finally {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch {}
  }
});

// ── injectSkillsInline ─────────────────────────────────────────────────────────

test('injectSkillsInline: prepends skill content when skillsRuntime=false', () => {
  const skillsDir = makeTmpDir();
  try {
    for (const skill of ['caveman', 'interrogate', 'strict-assessment']) {
      fs.mkdirSync(path.join(skillsDir, skill), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, skill, 'SKILL.md'), `# ${skill} rules\nDo the ${skill} thing.`, 'utf8');
    }
    const result = provider.injectSkillsInline('Original prompt.', skillsDir);
    assert.ok(result.includes('caveman rules'), 'must include caveman skill');
    assert.ok(result.includes('interrogate rules'), 'must include interrogate skill');
    assert.ok(result.includes('strict-assessment rules'), 'must include strict-assessment skill');
    assert.ok(result.endsWith('Original prompt.'), 'original prompt must be at end');
    assert.ok(result.indexOf('caveman') < result.indexOf('Original prompt.'), 'skills prepended before prompt');
  } finally {
    try { fs.rmSync(skillsDir, { recursive: true, force: true }); } catch {}
  }
});

test('injectSkillsInline: absent skill files are silently skipped (no crash)', () => {
  const skillsDir = makeTmpDir();
  try {
    // Only create one of three skills
    fs.mkdirSync(path.join(skillsDir, 'interrogate'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'interrogate', 'SKILL.md'), '# interrogate\nAsk questions.', 'utf8');
    const result = provider.injectSkillsInline('Prompt text.', skillsDir);
    assert.ok(result.includes('interrogate'), 'must include present skill');
    assert.ok(result.includes('Prompt text.'), 'original prompt present');
    // No throw = pass
  } finally {
    try { fs.rmSync(skillsDir, { recursive: true, force: true }); } catch {}
  }
});

test('injectSkillsInline: empty skillsDir returns original prompt unchanged', () => {
  const skillsDir = makeTmpDir();
  try {
    const result = provider.injectSkillsInline('My prompt.', skillsDir);
    assert.strictEqual(result, 'My prompt.', 'no skills -> prompt unchanged');
  } finally {
    try { fs.rmSync(skillsDir, { recursive: true, force: true }); } catch {}
  }
});

test('injectSkillsInline + interrogate: ## Clarifying Questions header triggers harness pause regex', () => {
  // Verify that inlined interrogate skill does not break the harness pause-logic
  // regex: /^##+\s*Clarifying Questions\b/im used in run-agent.js to detect pause state.
  // The skill content must NOT produce a false-positive by itself; the agent's RESPONSE
  // containing "## Clarifying Questions" in the prompt-output must still be detectable.
  const skillsDir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(skillsDir, 'interrogate'), { recursive: true });
    // Simulate a skill that instructs the model to emit the header — the header itself
    // appears in the skill body as an instruction string, not as a live Markdown heading.
    const skillBody = 'When you need clarification, emit a section whose header is EXACTLY the literal string `## Clarifying Questions`.';
    fs.writeFileSync(path.join(skillsDir, 'interrogate', 'SKILL.md'), skillBody, 'utf8');

    const injectedPrompt = provider.injectSkillsInline('Do the task.', skillsDir);

    // Simulate a model response that includes the actual ## Clarifying Questions heading.
    const modelResponse = injectedPrompt + '\n\n## Clarifying Questions\n\n1. What is the target file?\n2. Should I overwrite existing content?\n';

    // This is the exact regex run-agent.js uses to detect the pause point.
    const pauseRegex = /^##+\s*Clarifying Questions\b/im;
    assert.ok(pauseRegex.test(modelResponse), 'harness pause regex must match ## Clarifying Questions in response');

    // The skill instruction text uses backtick-wrapped text, not a bare heading,
    // so it must NOT trigger a false positive on just the injected prompt alone.
    // (run-agent.js only scans the *response* written to the history file, not the prompt,
    // but we verify the property here for completeness.)
    assert.ok(!pauseRegex.test(injectedPrompt), 'injected prompt alone must not false-positive the pause regex');
  } finally {
    try { fs.rmSync(skillsDir, { recursive: true, force: true }); } catch {}
  }
});

// ── GA JSONL format (@github/copilot v1.0+, Feb 2026) ────────────────────────

test('parseCopilotLogEntry: GA assistant.message with data.content', () => {
  const r = parse({ type: 'assistant.message', data: { content: 'Here is the result.' } });
  assert.strictEqual(r.kind, 'assistant_text');
  assert.strictEqual(r.text, 'Here is the result.');
});

test('parseCopilotLogEntry: GA assistant.usage with data.inputTokens + cacheReadTokens', () => {
  const r = parse({ type: 'assistant.usage', data: { inputTokens: 150, outputTokens: 280, cacheReadTokens: 40, cacheWriteTokens: 10 } });
  assert.strictEqual(r.kind, 'usage');
  assert.strictEqual(r.input_tokens, 150);
  assert.strictEqual(r.output_tokens, 280);
  assert.strictEqual(r.cache_read_tokens, 40);
  assert.strictEqual(r.cache_write_tokens, 10);
});

test('parseCopilotLogEntry: GA session.error quota -> error_quota', () => {
  const r = parse({ type: 'session.error', data: { errorType: 'quota', message: 'Request exceeded quota limits', statusCode: 403 } });
  assert.strictEqual(r.kind, 'error_quota');
  assert.ok(r.message.includes('quota'));
});

test('parseCopilotLogEntry: GA session.error rate_limit -> error_quota', () => {
  const r = parse({ type: 'session.error', data: { errorType: 'rate_limit', message: 'Rate limit exceeded', statusCode: 429 } });
  assert.strictEqual(r.kind, 'error_quota');
});

test('parseCopilotLogEntry: GA session.error authentication -> error_auth', () => {
  const r = parse({ type: 'session.error', data: { errorType: 'authentication', message: 'Not authenticated', statusCode: 401 } });
  assert.strictEqual(r.kind, 'error');
  assert.strictEqual(r.code, 'error_auth');
});

test('parseCopilotLogEntry: GA tool.request', () => {
  const r = parse({ type: 'tool.request', data: { toolCallId: 'tc-ga-1', name: 'Read', arguments: { file_path: '/ga.js' } } });
  assert.strictEqual(r.kind, 'tool_call');
  assert.strictEqual(r.id, 'tc-ga-1');
  assert.strictEqual(r.name, 'Read');
  assert.deepStrictEqual(r.input, { file_path: '/ga.js' });
});

test('parseCopilotLogEntry: GA tool.response', () => {
  const r = parse({ type: 'tool.response', data: { toolCallId: 'tc-ga-1', output: 'file content here' } });
  assert.strictEqual(r.kind, 'tool_result');
  assert.strictEqual(r.call_id, 'tc-ga-1');
  assert.strictEqual(r.output, 'file content here');
  assert.strictEqual(r.is_error, false);
});

test('parseCopilotLogEntry: session.shutdown returns null', () => {
  const r = parse({ type: 'session.shutdown', data: { modelMetrics: {} } });
  assert.strictEqual(r, null);
});

test('parseStream: GA full JSONL fixture with cache tokens', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'assistant.message', data: { content: 'Analyzing...' } },
      { type: 'tool.request', data: { toolCallId: 'tc-ga-1', name: 'Read', arguments: { file_path: '/src/x.js' } } },
      { type: 'tool.response', data: { toolCallId: 'tc-ga-1', output: 'const x = 42;' } },
      { type: 'assistant.message', data: { content: 'Fix applied.' } },
      { type: 'assistant.usage', data: { inputTokens: 300, outputTokens: 120, cacheReadTokens: 50, cacheWriteTokens: 20 } },
    ]);
    const events = provider.parseStream(0, tmpDir, '');
    const types = events.map(e => e.type);
    assert.ok(types.includes('assistant_text'), 'must have assistant_text');
    assert.ok(types.includes('tool_call'), 'must have tool_call');
    assert.ok(types.includes('tool_result'), 'must have tool_result');
    assert.ok(types.includes('usage'), 'must have usage');
    assert.ok(types.includes('done'), 'must have done');

    const textEvents = events.filter(e => e.type === 'assistant_text');
    assert.strictEqual(textEvents.length, 2, 'two GA text messages');
    assert.strictEqual(textEvents[0].content.text, 'Analyzing...');
    assert.strictEqual(textEvents[1].content.text, 'Fix applied.');

    const toolCall = events.find(e => e.type === 'tool_call');
    assert.strictEqual(toolCall.content.id, 'tc-ga-1');
    assert.strictEqual(toolCall.content.name, 'Read');

    const usageEvent = events.find(e => e.type === 'usage');
    assert.strictEqual(usageEvent.content.input_tokens, 300);
    assert.strictEqual(usageEvent.content.output_tokens, 120);
    assert.strictEqual(usageEvent.content.cache_read_tokens, 50);
    assert.strictEqual(usageEvent.content.cache_write_tokens, 20);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('parseStream: GA session.error quota -> error event with code error_quota', () => {
  const tmpDir = makeTmpDir();
  try {
    writeJsonl(tmpDir, [
      { type: 'assistant.message', data: { content: 'Working...' } },
      { type: 'session.error', data: { errorType: 'quota', message: 'Request exceeded quota limits', statusCode: 403 } },
    ]);
    const events = provider.parseStream(1, tmpDir, '');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, 'must have error event');
    assert.strictEqual(err.content.code, 'error_quota');
    assert.strictEqual(events[events.length - 1].type, 'done');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── spawnCopilot: copilot-cli-settings memory prefix ──────────────────────────

// Helper: write a temp config JSON, run spawnCopilot with _spawn injection,
// capture the -p argument, clean up. Returns the captured prompt string.
function runSpawnWithConfig(cfgObj, prompt) {
  const tmpCfg = path.join(os.tmpdir(), `copilot-test-cfg-${process.hrtime.bigint()}.json`);
  fs.writeFileSync(tmpCfg, JSON.stringify(cfgObj), 'utf8');
  let captured = null;
  try {
    const fakeChild = makeFakeChild();
    provider.spawnCopilot({
      prompt,
      silent: true,
      _spawn: (_bin, args) => { captured = args; return fakeChild; },
      _configPath: tmpCfg,
    });
  } finally {
    try { fs.unlinkSync(tmpCfg); } catch {}
    provider._clearHooks();
  }
  const pIdx = captured ? captured.indexOf('-p') : -1;
  return pIdx >= 0 ? captured[pIdx + 1] : null;
}

test('spawnCopilot: copilot-cli-settings memory:"on" prefixes prompt with /memory on', () => {
  const result = runSpawnWithConfig({ 'copilot-cli-settings': { memory: 'on' } }, 'Do the task.');
  assert.ok(result, 'spawn must be called');
  assert.ok(result.startsWith('/memory on\n\n'), 'prompt prefixed with /memory on');
  assert.ok(result.includes('Do the task.'), 'original prompt preserved');
});

test('spawnCopilot: copilot-cli-settings memory:"off" does not prefix prompt', () => {
  const result = runSpawnWithConfig({ 'copilot-cli-settings': { memory: 'off' } }, 'Do the task.');
  assert.strictEqual(result, 'Do the task.', 'prompt unchanged when memory=off');
});

test('spawnCopilot: copilot-cli-settings memory:"none" does not prefix prompt', () => {
  const result = runSpawnWithConfig({ 'copilot-cli-settings': { memory: 'none' } }, 'Do the task.');
  assert.strictEqual(result, 'Do the task.', 'prompt unchanged when memory=none');
});

test('spawnCopilot: absent copilot-cli-settings does not prefix prompt', () => {
  const result = runSpawnWithConfig({}, 'Do the task.');
  assert.strictEqual(result, 'Do the task.', 'prompt unchanged when copilot-cli-settings absent');
});

// ── Summary ────────────────────────────────────────────────────────────────────

if (_failed > 0) {
  console.error(`\n${_failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
