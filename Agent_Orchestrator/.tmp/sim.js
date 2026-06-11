'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'C:/Users/ryan.stephen/Repos/AMA/homestead-exporter-reports';
const histAll = fs.readFileSync(path.join(ROOT, 'Claude_Code_Harness/topic_files/claude_harness/claude_harness.md'), 'utf8');
const lines = histAll.split('\n');
const truncated = lines.slice(0, 2124).join('\n');
const histPath = path.join(ROOT, 'Claude_Code_Harness/.tmp/hist_test.md');
fs.writeFileSync(histPath, truncated, 'utf8');

const CONTEXT_TRUNCATION = 400;
const ANY_RESPONSE_HEADER = '(?:Planning|Coding|Assessment)\\s+Agent(?:\\s+\\d+)?\\s+Response(?:\\s*\\(Remediation(?:\\s+task-\\d+)?\\))?(?:\\s*\\(task-\\d+\\))?';

const content = fs.readFileSync(histPath, 'utf8');
const clearMarker = '--- CLEAR CONTEXT ---';
const lastClearIdx = content.lastIndexOf(clearMarker);
const raw = lastClearIdx >= 0 ? content.slice(lastClearIdx + clearMarker.length) : content;
const MASK = '\x00##';
const masked = raw.replace(/`{3}[\s\S]*?`{3}/g, block => block.replace(/^##/gm, MASK));
const headerSplit = new RegExp(`^(##\\s+(?:User Prompt(?:\\s+\\([^)\\n]*\\))?|User Reply to Questions|Auto Reply to Clarifying Questions|Auto Answer|${ANY_RESPONSE_HEADER}))\\s*$`, 'gim');
const parts = masked.split(headerSplit);
console.log('parts.length:', parts.length);

let blocks = [];
for (let i = 1; i + 1 < parts.length; i += 2) {
  const header = parts[i].trim();
  const text = parts[i + 1].replace(/\x00##/g, '##').replace(/\n---\s*$/, '').trim();
  if (text) blocks.push({ header, text });
}
let lastUserPromptIdx = -1;
for (let i = 0; i < blocks.length; i++) {
  if (/^##\s+User Prompt\b/i.test(blocks[i].header.trim())) lastUserPromptIdx = i;
}
console.log('lastUserPromptIdx:', lastUserPromptIdx, 'of', blocks.length);
if (lastUserPromptIdx >= 0) blocks = blocks.slice(lastUserPromptIdx);
console.log('after slice:', blocks.length);
blocks.forEach((b, i) => console.log(i, '|', b.header, '| head:', b.text.slice(0, 100).replace(/\n/g, ' ')));
