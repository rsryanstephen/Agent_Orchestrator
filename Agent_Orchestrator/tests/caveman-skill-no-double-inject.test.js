#!/usr/bin/env node
'use strict';

/**
 * Regression: the `caveman` skill must NOT be inlined via SKILLS_INLINE_DEFAULTS /
 * buildInlinedSkillsClause, because buildSystemPrompt already injects cavemanClause
 * unconditionally for every role. Inlining it too would double-inject the caveman
 * body on providers without a native skillsRuntime (gemini, github-copilot,
 * stub-fixture) when `use-caveman` is on — wasting tokens.
 *
 * Discipline (regression-test skill / diagnostic H1+H4): NO source-grep. This
 * spawns `node src/run-agent.js <topic> coding` under the deterministic
 * `stub-fixture` provider (skillsRuntime=false, so SKILLS_INLINE_DEFAULTS ARE
 * inlined) with `use-caveman` ON, captures the REAL built system prompt via the
 * stub's HARNESS_STUB_DUMP_PAYLOAD hook, and asserts on the prompt the model
 * would actually receive — not on run-agent.js source text. If the double-inject
 * regression returns, the caveman body appears twice and the count assertion fails.
 *
 * Run: node Agent_Orchestrator/tests/caveman-skill-no-double-inject.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const HARNESS = path.join(__dirname, '..');
const ROOT = path.join(HARNESS, '..');
const RUN_AGENT = path.join(HARNESS, 'src', 'run-agent.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'coding-basic.jsonl');

// Distinctive markers.
const CAVEMAN_BODY_LINE = 'Respond terse like smart caveman.'; // first line of caveman SKILL.md body
const INLINE_CAVEMAN_MARKER = '## Skill: caveman';             // would appear iff caveman was inlined

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e && (e.stack || e.message || e)}`); }
}

function uniqueTopic() { return `__caveman_${process.pid}_${Date.now().toString(36)}`; }

// Isolated scratch root OUTSIDE real topic_files/ so test churn never flickers in
// the user's topic_files explorer. Shared by setupTopic + the AGENT_ORCH_TOPICS_DIR env.
const TOPICS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orch-caveman-'));

// Plant a throwaway topic under the isolated TOPICS_ROOT with use-caveman ON and the
// stub-fixture provider (no skillsRuntime -> SKILLS_INLINE_DEFAULTS get inlined).
function setupTopic() {
  const topic = uniqueTopic();
  fs.mkdirSync(TOPICS_ROOT, { recursive: true });
  const topicDir = path.join(TOPICS_ROOT, topic);
  fs.mkdirSync(topicDir, { recursive: true });
  const topicConfig = {
    'stage-and-commit': false,
    'output-verbosity': 1,
    'max-concurrent-agents': 1,
    'auto-answer-clarifying-questions-and-submit': false,
    'provider': 'stub-fixture',
    'models': { 'planning': 'stub-model', 'coding': 'stub-model', 'assessment': 'stub-model' },
    'model-effort': { 'planning': 'low', 'coding': 'low', 'assessment': 'low' },
    'context-files': [],
    'use-strict-assessment': false,
    'use-caveman': true,
    'use-karpathy': false,
    'use-interrogate': false,
    'use-regression-skill': false,
    'regression-tests': false,
  };
  fs.writeFileSync(path.join(topicDir, 'topic-config.json'), JSON.stringify(topicConfig, null, 2), 'utf8');
  const history = `# ${topic}\n\n## User Prompt\nEcho the sentinel — the stub returns a canned line.\n`;
  fs.writeFileSync(path.join(topicDir, `${topic}.md`), history, 'utf8');
  return { topic, topicDir };
}

// Retry teardown: a freshly-exited child can briefly hold a topic-config .lock.
// Removes the whole isolated TOPICS_ROOT so nothing leaks into real topic_files/.
function teardown() {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(TOPICS_ROOT, { recursive: true, force: true }); if (!fs.existsSync(TOPICS_ROOT)) return; } catch {}
    try { const t = Date.now() + 100; while (Date.now() < t) { /* brief spin */ } } catch {}
  }
}

// Spawn the binary for the coding role and return the captured prompt dump.
function runCoding(topic) {
  const counterPath = path.join(os.tmpdir(), `caveman-counter-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
  const dumpPath = path.join(os.tmpdir(), `caveman-dump-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
  const isolatedLastTopic = path.join(os.tmpdir(), `caveman-last-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.writeFileSync(counterPath, '0', 'utf8');
  const env = {
    ...process.env,
    HARNESS_PROVIDER_OVERRIDE: 'stub-fixture',
    HARNESS_STUB_FIXTURE_PATH: FIXTURE,
    HARNESS_STUB_FIXTURE_COUNTER: counterPath,
    HARNESS_STUB_DUMP_PAYLOAD: dumpPath,
    AGENT_ORCH_LAST_TOPIC_PATH: isolatedLastTopic,
    AGENT_ORCH_TOPICS_DIR: TOPICS_ROOT,
    NODE_ENV: 'test',
    CI: '1',
  };
  const res = spawnSync(process.execPath, [RUN_AGENT, topic, 'coding'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  let dump = '';
  try { dump = fs.readFileSync(dumpPath, 'utf8'); } catch {}
  try { fs.unlinkSync(counterPath); } catch {}
  try { fs.unlinkSync(dumpPath); } catch {}
  try { fs.unlinkSync(isolatedLastTopic); } catch {}
  return { res, dump };
}

function countOccurrences(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// The dump file may hold several appended spawn payloads (one per phase the run
// drives), separated by the stub's sentinel. The double-inject guarantee is
// PER built prompt, so split on the sentinel and count within each payload.
function payloadSegments(dump) {
  return dump.split('__STUB_PAYLOAD_SEP__').map(s => s.trim()).filter(Boolean);
}

// The caveman body must reach the model exactly once per built prompt (via
// cavemanClause) and never a second time via the inlined-skills block — that is
// the whole anti-double-inject guarantee, asserted on the real built prompt.
test('caveman body is injected exactly once per built prompt under a no-skillsRuntime provider', () => {
  const { topic, topicDir } = setupTopic();
  try {
    const { dump } = runCoding(topic);
    assert.ok(dump.length, 'payload dump must be captured');
    const withCaveman = payloadSegments(dump).filter(s => s.includes(CAVEMAN_BODY_LINE));
    assert.ok(withCaveman.length, 'caveman body must be present (cavemanClause) when use-caveman is on');
    for (const seg of withCaveman) {
      assert.strictEqual(countOccurrences(seg, CAVEMAN_BODY_LINE), 1,
        'caveman body must appear EXACTLY once per prompt — a second copy means the SKILLS_INLINE_DEFAULTS double-inject regression returned');
    }
  } finally { teardown(); }
});

// SKILLS_INLINE_DEFAULTS must not surface caveman as its own inlined skill block.
test('inlined-skills block does not contain a caveman skill section', () => {
  const { topic, topicDir } = setupTopic();
  try {
    const { dump } = runCoding(topic);
    assert.ok(!dump.includes(INLINE_CAVEMAN_MARKER),
      'caveman must be filtered out of the inlined-skills list (cavemanClause owns its delivery)');
  } finally { teardown(); }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
