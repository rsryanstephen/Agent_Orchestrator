'use strict';

// Pure fan-out helpers extracted from run-agent.js so they can be unit-tested
// without spawning the full agent runner.

const ROLE_HEADER = {
  planning:   'Planning Agent Response',
  coding:     'Coding Agent Response',
  assessment: 'Assessment Agent Response',
  fix:        'Coding Agent Response (Remediation)',
  ask:        'Ask Agent Response', // Q&A mode — answers without modifying files
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

// Pure reducer for the module-level `plannedSubtasks` state in run-agent.js.
// Contract: the return value IS the new value of `plannedSubtasks` for this
// planning round. By making the reducer return null when the plan has no
// `## Parallel Tasks` section (instead of leaving the prior value untouched),
// callers can assign unconditionally — `plannedSubtasks = nextPlannedSubtasksFromPlan(text)` —
// which structurally prevents the round-N-to-round-N+1 leak that motivated this helper.
// Tested behaviorally in tests/planning-subtasks-reset.test.js without relying on
// source-grep of run-agent.js internals.
function nextPlannedSubtasksFromPlan(planText) {
  const parsed = parsePlanningSubtasks(planText);
  return Array.isArray(parsed) && parsed.length >= 2 ? parsed : null;
}

// Extracts the text body of a section (header + content) from markdown.
// Uses recognized section-boundary headers only (not arbitrary "## ") to prevent
// false splits when agent sub-headers (e.g. `## Plan`, `## Verified Citations`)
// appear inside the response body. Masks fenced code blocks before boundary search
// to avoid mismatches when `##` appears inside code.
//
// Args:
//   content: raw markdown string
//   headerPattern: regex pattern matching the desired section header (e.g. "Planning Agent Response")
//   anyResponseHeader: the ANY_RESPONSE_HEADER pattern string (for recognized boundaries)
//
// Returns: trimmed body text (without markdown `---` line), or null if header not found / body empty.
function extractLatestSection(content, headerPattern, anyResponseHeader) {
  const re = new RegExp(`^##\\s+${headerPattern}[^\\n]*$`, 'gim');
  let lastMatch = null;
  let m;
  while ((m = re.exec(content)) !== null) lastMatch = m;
  if (!lastMatch) return null;
  const tail = content.slice(lastMatch.index + lastMatch[0].length);

  // Mask fenced code blocks before searching for boundary headers, so a `##`
  // inside ``` code ``` never falsely triggers a section split.
  const MASK = '\x00##';
  const masked = tail.replace(/`{3}[\s\S]*?`{3}/g, block => block.replace(/^##/gm, MASK));

  // Stop at the next recognized section boundary: User Prompt, response headers, etc.
  // Explicitly list recognized boundaries (NOT arbitrary `## `) to avoid truncation
  // when agent sub-headers appear in the response body.
  const boundaryRe = new RegExp(`^##\\s+(?:User Prompt(?:\\s+\\([^)\\n]*\\))?|User Reply to Questions|Auto Reply to Clarifying Questions|Auto Answer|${anyResponseHeader})\\s*$`, 'im');
  const nextHeader = masked.search(boundaryRe);
  const body = nextHeader >= 0 ? masked.slice(0, nextHeader) : masked;

  // Unmask code blocks and clean trailing separators.
  return body.replace(/\x00##/g, '##').replace(/\n---\s*$/, '').trim() || null;
}

module.exports = { splitPromptIntoTasks, parsePlanningSubtasks, nextPlannedSubtasksFromPlan, roleHeaderFor, ROLE_HEADER, extractLatestSection };
