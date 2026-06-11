'use strict';

/**
 * Parallel-queue batch orchestrator.
 *
 * Responsibilities:
 *   - Split the queue file into non-`(hold)` and `(hold)` blocks.
 *   - Dispatch non-hold blocks in FIFO order, each into its own ephemeral
 *     sub-topic dir under `<topic>/.parallel/<slug>-<index>/`, capturing the
 *     original queue index at dispatch time (for deterministic consolidation).
 *   - Run subject to the global `parallel-semaphore`.
 *   - Consolidate per-agent histories back into the main topic history under
 *     a `## Parallel Batch <timestamp>` header in original FIFO order — write
 *     funneled through `file-write-queue` so concurrent runners cannot tear
 *     the consolidated section.
 *   - Optionally place each agent in its own git worktree so parallel edits to
 *     the same files do not stomp each other in the live working tree.
 *   - Sweep stale `.parallel/*` dirs older than N hours on startup.
 *   - Combine `git add -A && git commit` from each sub-agent into ONE commit
 *     on the parent branch when `stage-and-commit` is on.
 *
 * Hold blocks are returned untouched for the sequential path.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const semaphore = require('./parallel-semaphore');
const fileWriteQueue = require('./file-write-queue');

const STALE_HOURS_DEFAULT = 12;

function slugify(text, fallback = 'task') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

/**
 * Pure split. Preserves original queue index per block so consolidation can
 * order by it regardless of completion order.
 * @param {Array<{header?:string, body:string, isHold?:boolean}>} blocks
 */
function partitionBlocks(blocks) {
  const parallel = [];
  const hold = [];
  blocks.forEach((b, i) => {
    const entry = { ...b, queueIndex: i };
    if (b.isHold || b.held) hold.push(entry);
    else parallel.push(entry);
  });
  return { parallel, hold };
}

function subTopicDir(topicDir, slug, index) {
  return path.join(topicDir, '.parallel', `${slug}-${index}`);
}

function sweepStaleParallelDirs(topicDir, staleHours = STALE_HOURS_DEFAULT, now = Date.now()) {
  const root = path.join(topicDir, '.parallel');
  if (!fs.existsSync(root)) return [];
  const cutoff = now - staleHours * 3600 * 1000;
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.mtimeMs < cutoff) {
      try { fs.rmSync(full, { recursive: true, force: true }); removed.push(full); } catch {}
    }
  }
  return removed;
}

// ── Staging: per-prompt synchronous write + FIFO splice gate ─────────────────
// Staging files are written at dequeue time (before any runner starts) so a
// crash during the batch does not silently drop prompts. On normal completion
// the staging files are deleted after appendConsolidated succeeds. On crash,
// recoverStagingOrphans() splices completed entries into history and
// re-prepends incomplete ones to prompt-queue.md.

function getStagingDir(topicDir) {
  return path.join(topicDir, '.staging');
}

function getStagingFilePath(stageDir, seqIndex, slug) {
  return path.join(stageDir, `${String(seqIndex).padStart(4, '0')}-${slugify(slug)}.md`);
}

function getStagingDonePath(stageDir, seqIndex, slug) {
  return getStagingFilePath(stageDir, seqIndex, slug) + '.done';
}

function writeStagingPrompt(topicDir, seqIndex, slug, promptBody) {
  const dir = getStagingDir(topicDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = getStagingFilePath(dir, seqIndex, slug);
  fs.writeFileSync(file, `## User Prompt (From the Queue)\n\n${promptBody || ''}\n`, 'utf8');
  return file;
}

function markStagingComplete(topicDir, seqIndex, slug, agentOutput) {
  const dir = getStagingDir(topicDir);
  fs.writeFileSync(getStagingDonePath(dir, seqIndex, slug), String(agentOutput || ''), 'utf8');
}

function listStagingEntries(topicDir) {
  const dir = getStagingDir(topicDir);
  if (!fs.existsSync(dir)) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter(n => n.endsWith('.md'))
    .sort()
    .map(name => {
      const seqIndex = parseInt(name, 10) || 0;
      const slug = name.slice(5, -3);
      const filePath = path.join(dir, name);
      const donePath = filePath + '.done';
      return { name, seqIndex, slug, filePath, donePath, isDone: fs.existsSync(donePath) };
    });
}

// FIFO splice gate: advance from spliceState.next, appending consecutive done
// entries (prompt header + agent output) to historyPath. Mutates spliceState.next.
// Synchronous — suitable for tests and crash recovery. Production callers use
// tryAdvanceSplicer which serialises through file-write-queue.
function spliceStagingSync(historyPath, topicDir, spliceState) {
  const entries = listStagingEntries(topicDir);
  const bySeq = new Map(entries.map(e => [e.seqIndex, e]));
  while (true) {
    const entry = bySeq.get(spliceState.next);
    if (!entry || !entry.isDone) break;
    let promptContent = '';
    try { promptContent = fs.readFileSync(entry.filePath, 'utf8'); } catch {}
    let agentOutput = '';
    try { agentOutput = fs.readFileSync(entry.donePath, 'utf8'); } catch {}
    let prev = '';
    try { prev = fs.readFileSync(historyPath, 'utf8'); } catch {}
    const sep = prev.length && !prev.endsWith('\n') ? '\n' : '';
    const toAppend = `${sep}\n---\n\n${promptContent.trimEnd()}\n\n${agentOutput.trimEnd()}\n`;
    fs.appendFileSync(historyPath, toAppend, 'utf8');
    try { fs.unlinkSync(entry.filePath); } catch {}
    try { fs.unlinkSync(entry.donePath); } catch {}
    spliceState.next++;
  }
}

async function tryAdvanceSplicer(historyPath, topicDir, spliceState) {
  return fileWriteQueue.runExclusive(historyPath, () => {
    spliceStagingSync(historyPath, topicDir, spliceState);
  });
}

// Startup recovery: splice completed staging files into history (with interrupt
// marker); re-prepend incomplete ones (runner crashed) to prompt-queue.md.
// Returns { spliced, requeued }.
function recoverStagingOrphans(topicDir, historyPath, queuePath) {
  const entries = listStagingEntries(topicDir);
  if (entries.length === 0) return { spliced: 0, requeued: 0 };
  let spliced = 0;
  const toRequeue = [];
  for (const entry of entries) {
    if (entry.isDone) {
      let promptContent = '';
      try { promptContent = fs.readFileSync(entry.filePath, 'utf8'); } catch {}
      let agentOutput = '';
      try { agentOutput = fs.readFileSync(entry.donePath, 'utf8'); } catch {}
      let prev = '';
      try { prev = fs.readFileSync(historyPath, 'utf8'); } catch {}
      const sep = prev.length && !prev.endsWith('\n') ? '\n' : '';
      const marker = '\n<!-- interrupted batch — recovered by auto-resume -->\n';
      const toAppend = `${sep}${marker}\n---\n\n${promptContent.trimEnd()}\n\n${agentOutput.trimEnd()}\n`;
      fs.appendFileSync(historyPath, toAppend, 'utf8');
      try { fs.unlinkSync(entry.filePath); } catch {}
      try { fs.unlinkSync(entry.donePath); } catch {}
      spliced++;
    } else {
      let promptContent = '';
      try { promptContent = fs.readFileSync(entry.filePath, 'utf8'); } catch {}
      const body = promptContent.replace(/^##\s+User Prompt[^\n]*\n+/, '').trimEnd();
      toRequeue.push(body);
      try { fs.unlinkSync(entry.filePath); } catch {}
    }
  }
  if (toRequeue.length > 0 && queuePath) {
    let existing = '';
    try { existing = fs.readFileSync(queuePath, 'utf8').trimEnd(); } catch {}
    const prepend = toRequeue.join('\n\n---\n\n');
    const combined = existing ? `${prepend}\n\n---\n\n${existing}\n` : `${prepend}\n`;
    fs.writeFileSync(queuePath, combined, 'utf8');
  }
  return { spliced, requeued: toRequeue.length };
}

/**
 * Build the consolidated `## Parallel Batch <ts>` block from sub-topic
 * histories. `entries` = [{ queueIndex, slug, history }] in any order.
 */
function consolidate(entries, timestamp) {
  const ordered = [...entries].sort((a, b) => a.queueIndex - b.queueIndex);
  const ts = timestamp || 'unknown-time';
  const parts = [`## Parallel Batch ${ts}`, ''];
  for (const e of ordered) {
    parts.push(`### [${e.slug}] (queue #${e.queueIndex})`);
    parts.push('');
    parts.push(String(e.history || '').trimEnd());
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Append the consolidated block to the topic history file, funneled through
 * the file-write-queue so concurrent appenders cannot interleave.
 */
async function appendConsolidated(historyPath, consolidatedText) {
  return fileWriteQueue.runExclusive(historyPath, () => {
    let prev = '';
    try { prev = fs.readFileSync(historyPath, 'utf8'); } catch {}
    const sep = prev.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(historyPath, `${sep}\n${consolidatedText}\n`);
  });
}

// ── Git worktree isolation ────────────────────────────────────────────────
// Each parallel agent edits inside its own worktree so concurrent edits to
// overlapping files in the main working tree are impossible. After the batch
// completes, each worktree's diff is folded into the parent tree and the
// worktrees are removed; a single combined commit (when stage-and-commit is
// on) lands the union of changes.

function _git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    const err = new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').trim()}`);
    err.code = r.status;
    throw err;
  }
  return (r.stdout || '').trim();
}

function _gitSafe(args, cwd) {
  try { return _git(args, cwd); } catch { return null; }
}

function createWorktree(repoRoot, slug, qIdx) {
  const wtPath = path.join(repoRoot, '.parallel-wt', `${slug}-${qIdx}`);
  try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
  const branch = `parallel/${slug}-${qIdx}-${process.pid}`;
  _git(['worktree', 'add', '--detach', wtPath, 'HEAD'], repoRoot);
  return { wtPath, branch };
}

function foldWorktreeDiff(repoRoot, wtPath) {
  // Capture the worktree's diff against HEAD and apply it to repoRoot.
  const diff = _gitSafe(['diff', 'HEAD'], wtPath);
  if (!diff) return false;
  const patchFile = path.join(repoRoot, '.parallel-wt', `fold-${path.basename(wtPath)}.patch`);
  fs.writeFileSync(patchFile, diff);
  try {
    _git(['apply', '--3way', patchFile], repoRoot);
    return true;
  } finally {
    try { fs.unlinkSync(patchFile); } catch {}
  }
}

function removeWorktree(repoRoot, wtPath) {
  _gitSafe(['worktree', 'remove', '--force', wtPath], repoRoot);
  try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
}

/**
 * Stage every change in `repoRoot` and create ONE combined commit. Satisfies
 * requirement #4 — parallel agents must not produce N micro-commits.
 *
 * Returns the commit SHA, or null when the index has nothing to commit.
 */
function combinedCommit(repoRoot, message) {
  _gitSafe(['add', '-A'], repoRoot);
  const status = _gitSafe(['status', '--porcelain'], repoRoot);
  if (!status) return null;
  _git(['commit', '-m', message || 'parallel batch: combined commit'], repoRoot);
  return _gitSafe(['rev-parse', 'HEAD'], repoRoot);
}

/**
 * Run a batch. `runOne(entry, subDir, release)` MUST wrap its work in
 * try/finally release() so a crash never orphans a semaphore slot.
 *
 * The semaphore tag is `"<topicName>/<slug>"` — surfaces the topic name in
 * the CLI "capped at N parallel" notice (QA bullet 3 — slug-only was wrong).
 *
 * Returns { results, errors } where results preserves original FIFO order.
 */
async function runBatch({ entries, topicDir, topicName, maxParallel, runOne, onSlotBlocked }) {
  const sem = semaphore.getSemaphore(maxParallel);
  const results = new Array(entries.length);
  const errors = [];
  const tagFor = (slug) => topicName ? `${topicName}/${slug}` : slug;

  await Promise.all(entries.map(async (entry, i) => {
    const slug = slugify(entry.slug || entry.header || `task-${i}`);
    const subDir = subTopicDir(topicDir, slug, entry.queueIndex);
    // Fire `onSlotBlocked` ONLY when we are actually about to block — and
    // only via `acquire`'s own stderr notice (previously emitted twice: once
    // pre-acquire here, once inside acquire). QA bullet 3 — kill duplicate.
    const willBlock = sem.inUse >= sem.capacity;
    if (willBlock && typeof onSlotBlocked === 'function') {
      try { onSlotBlocked({ slug, tag: tagFor(slug), waiting: sem.waiting + 1 }); } catch {}
    }
    const release = await sem.acquire(tagFor(slug));
    try {
      results[i] = await runOne({ ...entry, slug, subDir, tag: tagFor(slug) }, release);
    } catch (err) {
      errors.push({ entry, slug, error: err });
      results[i] = null;
    } finally {
      release(); // safe — release() is idempotent
    }
  }));

  return { results, errors };
}

/**
 * End-to-end orchestrator. Reads the queue, partitions hold/non-hold,
 * dispatches the non-hold blocks via `runBatch`, optionally inside per-agent
 * git worktrees, consolidates histories, lands ONE combined commit, and
 * returns the hold-blocks plus a summary so the caller can resume serial
 * processing of `(hold)` items.
 *
 * `runner({entry, subDir, wtPath, writePromptBody})` is the per-agent driver
 * — typically spawns a child `run-agent.js` process. Must resolve to the
 * agent's history text (string) so consolidation can splice it in.
 */
async function runParallelQueueBatch({
  topicDir,
  topicName,
  historyPath,
  blocks,
  maxParallel,
  runner,
  stageAndCommit = false,
  useWorktree = false,
  repoRoot = null,
  timestamp,
  log = () => {},
}) {
  sweepStaleParallelDirs(topicDir);
  const { parallel, hold } = partitionBlocks(blocks);
  if (parallel.length === 0) return { dispatched: 0, hold, results: [], errors: [] };

  // Pre-compute slugs so staging write, runBatch, markStagingComplete, and cleanup all use
  // identical values. runBatch derives slug as `task-${i}` fallback (not 'task'), so we must
  // match that here. Idempotent: slugify(already-slugified) === already-slugified.
  parallel.forEach((entry, i) => {
    entry.slug = slugify(entry.slug || entry.header || `task-${i}`);
  });

  // Write staging prompts synchronously before any runner starts so a crash
  // cannot silently drop prompts from history.
  for (const entry of parallel) {
    try { writeStagingPrompt(topicDir, entry.queueIndex, entry.slug, entry.body); } catch {}
  }

  const created = [];
  const { results, errors } = await runBatch({
    entries: parallel,
    topicDir,
    topicName,
    maxParallel,
    runOne: async (entry) => {
      fs.mkdirSync(entry.subDir, { recursive: true });
      let wt = null;
      if (useWorktree && repoRoot) {
        try { wt = createWorktree(repoRoot, entry.slug, entry.queueIndex); }
        catch (e) { log(`worktree setup failed for ${entry.tag}: ${e.message} — falling back to in-place run`); }
      }
      const writeBody = () => {
        const sub = path.join(entry.subDir, `${entry.slug}.md`);
        fs.writeFileSync(sub, `# ${entry.slug}\n\n## User Prompt\n\n${entry.body || ''}\n`);
        return sub;
      };
      const history = await runner({ entry, subDir: entry.subDir, wtPath: wt && wt.wtPath, writePromptBody: writeBody });
      // Mark staging complete (entry.slug already slugified by runBatch).
      try { markStagingComplete(topicDir, entry.queueIndex, entry.slug, history || ''); } catch {}
      created.push({ queueIndex: entry.queueIndex, slug: entry.slug, history, wt });
      return history;
    },
  });

  // Fold worktree diffs back into the live tree.
  if (useWorktree && repoRoot) {
    for (const c of created) {
      if (!c.wt) continue;
      try { foldWorktreeDiff(repoRoot, c.wt.wtPath); }
      catch (e) { log(`fold worktree diff failed (${c.slug}): ${e.message}`); }
      try { removeWorktree(repoRoot, c.wt.wtPath); } catch {}
    }
  }

  // Splice completed entries into history in FIFO order via the staging gate.
  // This mirrors the sequential path: each entry lands as `## User Prompt (From the Queue)`
  // followed by agent output, rather than a `## Parallel Batch` wrapper.
  if (historyPath) {
    const startSeq = parallel.reduce((m, e) => Math.min(m, e.queueIndex), parallel[0].queueIndex);
    const spliceState = { next: startSeq };
    await tryAdvanceSplicer(historyPath, topicDir, spliceState);
    // spliceStagingSync unlinks files as it splices. Belt-and-suspenders: clean up any
    // residual staging files (entries spliceStagingSync did not reach on this call).
    const stageDir = getStagingDir(topicDir);
    for (const entry of parallel) {
      try { fs.unlinkSync(getStagingFilePath(stageDir, entry.queueIndex, entry.slug)); } catch {}
      try { fs.unlinkSync(getStagingDonePath(stageDir, entry.queueIndex, entry.slug)); } catch {}
    }
  }

  // ONE combined commit (QA blocker — requirement #4 was unimplemented).
  if (stageAndCommit && repoRoot) {
    try {
      const sha = combinedCommit(repoRoot, `parallel batch (${created.length} agent${created.length === 1 ? '' : 's'})`);
      if (sha) log(`combined commit ${sha.slice(0, 8)} created.`);
    } catch (e) {
      log(`combined commit failed: ${e.message}`);
    }
  }

  return { dispatched: parallel.length, hold, results, errors };
}

module.exports = {
  slugify,
  partitionBlocks,
  subTopicDir,
  sweepStaleParallelDirs,
  consolidate,
  appendConsolidated,
  runBatch,
  runParallelQueueBatch,
  // worktree + combined-commit primitives (exported for tests + future callers)
  createWorktree,
  foldWorktreeDiff,
  removeWorktree,
  combinedCommit,
  // staging + FIFO splice gate + crash recovery
  getStagingDir,
  writeStagingPrompt,
  markStagingComplete,
  listStagingEntries,
  spliceStagingSync,
  tryAdvanceSplicer,
  recoverStagingOrphans,
};
