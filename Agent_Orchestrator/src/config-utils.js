'use strict';

const fs = require('fs');
const path = require('path');

// Path + filename constants used to locate harness config from any entry point.
const HARNESS_DIR = path.join(__dirname, '..');
const GLOBAL_CONFIG_FILENAME = 'global-config.json';
const TOPIC_CONFIG_FILENAME = 'topic-config.json';
const DEFAULT_TOPIC_FILES_DIR = 'Agent_Orchestrator/topic_files';

function globalConfigPath() { return path.join(HARNESS_DIR, GLOBAL_CONFIG_FILENAME); }

// ---- JSONC parsing ----
// Hand-rolled comment stripper: walks the source one char at a time, tracking
// string/escape state so `//` and `/* */` inside string literals are preserved.
function stripJsonComments(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Cheap predicate — does the raw source contain any JSONC comment outside strings?
function hasComments(src) {
  let inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '/' && (n === '/' || n === '*')) return true;
  }
  return false;
}

// ---- Key-shape interop ----
// Config keys are kebab-case on disk; some legacy code reads camelCase. These
// helpers + aliasKebabKeys install bi-directional non-enumerable getters so
// either form works regardless of which the file uses.
function kebabToCamel(k) {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToKebab(k) {
  return k.replace(/([A-Z])/g, c => '-' + c.toLowerCase());
}

function aliasKebabKeys(obj, seen) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  seen = seen || new WeakSet();
  if (seen.has(obj)) return obj;
  seen.add(obj);
  const keys = Object.keys(obj);
  for (const k of keys) {
    aliasKebabKeys(obj[k], seen);
    if (k.includes('-')) {
      // kebab -> camelCase alias
      const camel = kebabToCamel(k);
      if (!(camel in obj)) {
        Object.defineProperty(obj, camel, {
          get() { return obj[k]; },
          set(v) { obj[k] = v; },
          enumerable: false,
          configurable: true,
        });
      }
    } else {
      // camelCase -> kebab alias
      const kebab = camelToKebab(k);
      if (kebab !== k && !(kebab in obj)) {
        Object.defineProperty(obj, kebab, {
          get() { return obj[k]; },
          set(v) { obj[k] = v; },
          enumerable: false,
          configurable: true,
        });
      }
    }
  }
  return obj;
}

// Read raw text + stripped variant + comment-presence flag in one pass.
function loadConfigText(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const stripped = stripJsonComments(raw);
  return { raw, stripped, hasComments: hasComments(raw) };
}

// Capture trailing `// ...` comments on top-level keys so writeConfig can re-emit them.
function extractRootInlineComments(raw) {
  const map = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^  "([^"]+)"\s*:\s.*?(\/\/.*)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

// ---- Legacy key migration ----
// Renames old config keys in-memory so callers see only the modern names.
// One-shot warning per process per key.
let _legacyKeyWarned = { ids: false, devilsAdvocate: false };
function migrateLegacyKeys(obj, configPath) {
  if (!obj || typeof obj !== 'object') return obj;
  // Legacy `ids` -> `topic-ids`.
  if ('ids' in obj && !('topic-ids' in obj)) {
    obj['topic-ids'] = obj.ids;
    delete obj.ids;
    if (!_legacyKeyWarned.ids) {
      _legacyKeyWarned.ids = true;
      try { console.error(`[config-utils] legacy "ids" key in ${configPath} mapped to "topic-ids" (in-memory).`); } catch {}
    }
  }
  // Legacy per-topic-config `id` -> `topic-id`.
  if ('id' in obj && !('topic-id' in obj) && typeof obj.id !== 'object') {
    obj['topic-id'] = obj.id;
    delete obj.id;
  }
  // Legacy `use-devils-advocate` -> `use-strict-assessment`.
  if ('use-devils-advocate' in obj && !('use-strict-assessment' in obj)) {
    obj['use-strict-assessment'] = obj['use-devils-advocate'];
    delete obj['use-devils-advocate'];
    if (!_legacyKeyWarned.devilsAdvocate) {
      _legacyKeyWarned.devilsAdvocate = true;
      try { console.error(`[config-utils] legacy "use-devils-advocate" key in ${configPath} mapped to "use-strict-assessment".`); } catch {}
    }
  }
  if ('useDevilsAdvocate' in obj && !('useStrictAssessment' in obj)) {
    obj['use-strict-assessment'] = obj['useDevilsAdvocate'];
    delete obj['useDevilsAdvocate'];
  }
  return obj;
}

// Top-level loader: read -> strip JSONC -> JSON.parse -> migrate -> alias keys.
// Stashes raw text, inline-comment map, and __hasComments on the returned object
// (non-enumerable) so writeConfig can faithfully round-trip the file.
function loadConfig(configPath) {
  const { raw, stripped, hasComments: hc } = loadConfigText(configPath);
  const obj = JSON.parse(stripped);
  migrateLegacyKeys(obj, configPath);
  aliasKebabKeys(obj);
  const inlineComments = hc ? extractRootInlineComments(raw) : {};
  Object.defineProperty(obj, '__hasComments', { value: hc, enumerable: false });
  Object.defineProperty(obj, '__rawText', { value: raw, enumerable: false });
  Object.defineProperty(obj, '__inlineComments', { value: inlineComments, enumerable: false, writable: true });
  return obj;
}

// Layered config read: prefer topic over global; accept either kebab or camel key.
function cfgRead(topicConfig, globalConfig, kebab, fallback) {
  const camel = kebabToCamel(kebab);
  if (topicConfig) {
    if (kebab in topicConfig && topicConfig[kebab] != null) return topicConfig[kebab];
    if (camel in topicConfig && topicConfig[camel] != null) return topicConfig[camel];
  }
  if (globalConfig) {
    if (kebab in globalConfig && globalConfig[kebab] != null) return globalConfig[kebab];
    if (camel in globalConfig && globalConfig[camel] != null) return globalConfig[camel];
  }
  return fallback;
}

// Scope-specificity resolver for the concurrency cap. A TOPIC-level value of
// EITHER `max-parallel-agents-per-topic` (new key) or `max-concurrent-agents`
// (legacy alias) must win over a GLOBAL value of either key. We deliberately do
// NOT use a single cfgRead-per-key cascade here: that would let a GLOBAL new-key
// value shadow a TOPIC legacy-key value. Pure (no module state) so it is unit
// testable. Returns the resolved positive number, or `fallback` when neither
// scope sets a usable (> 0) value.
function resolveMaxConcurrentAgents(topicConfig, globalConfig, fallback) {
  let v = cfgRead(topicConfig, {}, 'max-parallel-agents-per-topic', null);
  if (v == null) v = cfgRead(topicConfig, {}, 'max-concurrent-agents', null);
  if (v == null) v = cfgRead({}, globalConfig, 'max-parallel-agents-per-topic', null);
  if (v == null) v = cfgRead({}, globalConfig, 'max-concurrent-agents', null);
  // A numeric value > 0 wins (covers the serial case v===1). Non-numeric
  // config (e.g. the string "4") deliberately falls through to `fallback`:
  // we do not coerce strings, preserving prior behaviour.
  if (typeof v === 'number' && v > 0) return v;
  return fallback;
}

// Pure boolean resolver for `parallel-assessment-agents` (topic-over-global,
// kebab/camel). Default OFF: only literal true / "true" enables parallel
// assessors; everything else (false, "false", absent, junk) stays serial.
// Extracted so the described behaviour is unit-testable without the CLI.
function resolveParallelAssessmentAgents(topicConfig, globalConfig) {
  const v = cfgRead(topicConfig, globalConfig, 'parallel-assessment-agents', false);
  return v === true || v === 'true';
}

// Atomic write: serialize via safeJsonWrite, re-attaching any captured root inline comments.
function writeConfig(configPath, obj) {
  const clean = JSON.parse(JSON.stringify(obj));
  const comments = (obj && obj.__inlineComments) || {};
  let out = JSON.stringify(clean, null, 2);
  if (Object.keys(comments).length) {
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^  "([^"]+)"\s*:/);
      if (m && comments[m[1]]) lines[i] = lines[i] + ' ' + comments[m[1]];
    }
    out = lines.join('\n');
  }
  const { safeJsonWrite } = require('./lib/safe-json-write');
  safeJsonWrite(configPath, out + '\n');
}

// ---- Path resolvers ----
// Topic-files dir is configurable (defaults to Agent_Orchestrator/topic_files).
// The helpers below derive a topic's folder, topic-config path and history md path.
function resolveTopicFilesDir(globalConfig) {
  return (globalConfig && (globalConfig['topic-files-dir'] || globalConfig.topicFilesDir))
    || DEFAULT_TOPIC_FILES_DIR;
}

// Test-isolation seam: when AGENT_ORCH_TOPICS_DIR is set, treat it as the
// topic-files ROOT (skip projectRoot/config). Absolute -> used verbatim;
// relative -> resolved against projectRoot. Lets e2e/regression tests plant
// throwaway topics in a tmp tree instead of the real topic_files/, so the
// suite stops churning real topic dirs. No env -> original config/default path.
function topicDirFor(projectRoot, globalConfig, topicName) {
  // Highest-precedence override: a parallel-queue child agent is spawned with
  // AGENT_ORCH_TOPIC_DIR_OVERRIDE pointing at its ephemeral `.parallel/<slug>-<i>`
  // sub-topic dir. Returning it verbatim (ignoring topicName) makes
  // topicConfigPathFor / historyPathFor / the unknown-topic guard all resolve
  // into that self-contained dir, so the child runs without a global-config
  // `topic-ids` entry. Env-only — never a config edit (CONFIG GUARD-safe).
  const dirOverride = process.env.AGENT_ORCH_TOPIC_DIR_OVERRIDE;
  if (dirOverride) {
    return path.isAbsolute(dirOverride) ? dirOverride : path.join(projectRoot, dirOverride);
  }
  const envRoot = process.env.AGENT_ORCH_TOPICS_DIR;
  if (envRoot) {
    const root = path.isAbsolute(envRoot) ? envRoot : path.join(projectRoot, envRoot);
    return path.join(root, topicName);
  }
  return path.join(projectRoot, resolveTopicFilesDir(globalConfig), topicName);
}

function topicConfigPathFor(projectRoot, globalConfig, topicName) {
  return path.join(topicDirFor(projectRoot, globalConfig, topicName), TOPIC_CONFIG_FILENAME);
}

function historyPathFor(projectRoot, globalConfig, topicName) {
  return path.join(topicDirFor(projectRoot, globalConfig, topicName), `${topicName}.md`);
}

// Resilient topic-config load: on parse failure try the .bak sibling so a corrupt
// write doesn't brick the topic. Re-throws the original error if .bak also fails.
function loadTopicConfig(projectRoot, globalConfig, topicName) {
  const p = topicConfigPathFor(projectRoot, globalConfig, topicName);
  if (!fs.existsSync(p)) return null;
  try {
    return loadConfig(p);
  } catch (e) {
    const bak = p + '.bak';
    if (fs.existsSync(bak)) {
      try {
        const cfg = loadConfig(bak);
        console.error(`[config-utils] ${p} failed to parse (${e.message}); loaded last-known-good .bak`);
        return cfg;
      } catch (bakErr) {
        console.error(`[config-utils] .bak also failed to parse (${bakErr.message}); re-throwing original error`);
      }
    }
    throw e;
  }
}

function writeTopicConfig(projectRoot, globalConfig, topicName, obj) {
  const p = topicConfigPathFor(projectRoot, globalConfig, topicName);
  writeConfig(p, obj);
}

module.exports = {
  stripJsonComments,
  hasComments,
  kebabToCamel,
  camelToKebab,
  aliasKebabKeys,
  migrateLegacyKeys,
  loadConfig,
  loadConfigText,
  cfgRead,
  resolveMaxConcurrentAgents,
  resolveParallelAssessmentAgents,
  writeConfig,
  globalConfigPath,
  resolveTopicFilesDir,
  topicDirFor,
  topicConfigPathFor,
  historyPathFor,
  loadTopicConfig,
  writeTopicConfig,
  GLOBAL_CONFIG_FILENAME,
  TOPIC_CONFIG_FILENAME,
  DEFAULT_TOPIC_FILES_DIR,
};
