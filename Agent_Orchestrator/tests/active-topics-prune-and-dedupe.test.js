'use strict';

// Regression: the fleet heartbeat listed the same topic dozens of times
// because active-topics.json accumulated dead-pid entries (process.on('exit')
// misses SIGKILL/hard exits) and the reader never deduped by name.
// These tests assert the source contains the liveness-prune + dedupe logic.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'run-agent.js'),
  'utf8'
);

function bodyOf(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = SRC.indexOf('\nfunction ', start + 1);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

// 1. A pid-liveness helper exists and uses the kill(pid,0) probe.
const aliveBody = bodyOf('_isPidAlive');
assert.ok(/process\.kill\(pid,\s*0\)/.test(aliveBody), 'liveness probe missing kill(pid,0)');
assert.ok(/pid === process\.pid/.test(aliveBody), 'own-pid short-circuit missing');

// 2. readActiveTopics prunes dead pids AND dedupes by name.
const readBody = bodyOf('readActiveTopics');
assert.ok(/_isPidAlive\(t\.pid\)/.test(readBody), 'readActiveTopics does not prune dead pids');
assert.ok(/seen\.has\(t\.name\)/.test(readBody) && /seen\.add\(t\.name\)/.test(readBody),
  'readActiveTopics does not dedupe by name');

// 3. registerActiveTopic self-heals by dropping dead-pid entries.
const regBody = bodyOf('registerActiveTopic');
assert.ok(/_isPidAlive\(t\.pid\)/.test(regBody), 'registerActiveTopic does not prune dead pids');

console.log('active-topics-prune-and-dedupe: all assertions passed');
