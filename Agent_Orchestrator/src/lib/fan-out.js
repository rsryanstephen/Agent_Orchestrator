'use strict';

// Pure fan-out helpers extracted from run-agent.js so they can be unit-tested
// without spawning the full agent runner.

const ROLE_HEADER = {
  planning:   'Planning Agent Response',
  coding:     'Coding Agent Response',
  assessment: 'Assessment Agent Response',
  fix:        'Coding Agent Response (Remediation)',
};

// Header label written above each agent's response. When >1 sibling agents run
// in parallel, numbers each (e.g. "Coding Agent 2 Response").
function roleHeaderFor(role, n, total) {
  if (total <= 1) return ROLE_HEADER[role];
  if (role === 'fix') return `Coding Agent ${n} Response (Remediation)`;
  const base = role === 'planning' ? 'Planning' : role === 'assessment' ? 'Assessment' : 'Coding';
  return `${base} Agent ${n} Response`;
}

// Splits a prompt body into N independent task strings for parallel fan-out.
// Anchor priority: "Agent N:" markers, then numbered/bulleted list items at
// column 0. Preamble (text before first anchor) is prepended to each task so
// shared context isn't lost. Returns [content] if no multi-task structure found.
function splitPromptIntoTasks(content) {
  if (!content) return [content];
  const lines = content.split('\n');
  // Agent N: / Agent N - prefix takes priority over numbered/bulleted items.
  const agentRegex = /^\s*agent\s*(\d+)\s*[:.\-]?\s/i;
  const numberOrBulletRegex = /^(?:\d+[.)]|[-*•])\s+(.+)$/;
  const tryAnchor = (anchorTest) => {
    const items = [];
    const preamble = [];
    let current = null;
    let started = false;
    for (const line of lines) {
      const isAnchor = anchorTest(line);
      if (isAnchor) {
        if (current !== null) items.push(current);
        current = line;
        started = true;
      } else if (started) {
        current += '\n' + line;
      } else {
        preamble.push(line);
      }
    }
    if (current !== null) items.push(current);
    return { items, preamble };
  };
  let r = tryAnchor(l => agentRegex.test(l));
  if (r.items.length < 2) r = tryAnchor(l => numberOrBulletRegex.test(l) && !/^[ \t]/.test(l));
  if (r.items.length < 2) return [content];
  const pre = r.preamble.join('\n').trim();
  return r.items.map(it => (pre ? pre + '\n\n' : '') + it.trim());
}

// Extracts the `## Parallel Tasks` section from a planning agent's output and
// splits it into per-agent subtask strings. Returns null when missing or
// when only a single task is found (nothing to parallelise).
function parsePlanningSubtasks(planText) {
  if (!planText) return null;
  const m = planText.match(/##+\s*Parallel Tasks\s*\n([\s\S]*?)(?=\n##+\s|$)/i);
  if (!m) return null;
  const tasks = splitPromptIntoTasks(m[1].trim());
  if (tasks.length < 2) return null;
  return tasks;
}

module.exports = { splitPromptIntoTasks, parsePlanningSubtasks, roleHeaderFor, ROLE_HEADER };
