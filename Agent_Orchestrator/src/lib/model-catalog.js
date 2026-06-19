'use strict';

// model-catalog.js — dynamic model discovery and tier selection per provider.
// Fetches live model lists from provider APIs, caches results for 30 days,
// and selects best model per tier (heavy/medium/light) via regex heuristics.
// Falls back to static constants from run-agent.js when any fetch fails.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Cache file lives two levels above this file: Agent_Orchestrator/.model-catalog-cache.json
// Override via MODEL_CATALOG_CACHE_PATH env var (used by tests to inject fixtures
// without clobbering the real cache).
const CACHE_PATH = process.env.MODEL_CATALOG_CACHE_PATH
  || path.join(__dirname, '..', '..', '.model-catalog-cache.json');

// 30-day TTL in milliseconds
const CACHE_TTL_MS = 2592000000;

// ---------------------------------------------------------------------------
// Static fallback constants (mirrors run-agent.js:62-64).
// Used when a provider fetch fails or the catalog returns no usable IDs.
// ---------------------------------------------------------------------------
const STATIC_FALLBACKS = {
  'claude-code': {
    light:  'claude-haiku-4-5-20251001',
    medium: 'claude-sonnet-4-6',
    heavy:  'claude-opus-4-7',
  },
  // gpt-5/gpt-5-mini are unavailable on Copilot CLI; gpt-4.1 family is the last confirmed-working GPT tier.
  'github-copilot': {
    light:  'gpt-4.1-mini',
    medium: 'gpt-4.1',
    heavy:  'gpt-4.1',
  },
  'gemini': {
    light:  'gemini-2.5-flash',
    medium: 'gemini-2.5-pro',
    heavy:  'gemini-2.5-pro',
  },
  'gemini-vertex': {
    light:  'gemini-2.5-flash',
    medium: 'gemini-2.5-pro',
    heavy:  'gemini-2.5-pro',
  },
};

// ---------------------------------------------------------------------------
// Tier heuristics — evaluated in order; first match wins.
// Pattern tested against lowercased model ID.
// ---------------------------------------------------------------------------
const TIER_RULES = {
  'claude-code': [
    // heavy: opus (any version)
    { tier: 'heavy',  pattern: /opus/ },
    // light: haiku or flash (small/fast models)
    { tier: 'light',  pattern: /haiku|flash/ },
    // medium: everything else (sonnet, fable, etc.)
    { tier: 'medium', pattern: /./ },
  ],
  'github-copilot': [
    // heavy/medium: non-mini GPT flagship
    { tier: 'heavy',  pattern: /^gpt-\d+(?:\.\d+)?$/ },
    // light: mini or nano variants
    { tier: 'light',  pattern: /mini|nano|small/ },
    // medium fallback
    { tier: 'medium', pattern: /./ },
  ],
  'gemini': [
    // heavy/medium: pro models
    { tier: 'heavy',  pattern: /pro/ },
    // light: flash models
    { tier: 'light',  pattern: /flash/ },
    // medium fallback
    { tier: 'medium', pattern: /./ },
  ],
  'gemini-vertex': [
    { tier: 'heavy',  pattern: /pro/ },
    { tier: 'light',  pattern: /flash/ },
    { tier: 'medium', pattern: /./ },
  ],
};

// ---------------------------------------------------------------------------
// HTTP helper — returns response body as string, rejects on non-2xx / error.
// ---------------------------------------------------------------------------
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = { headers: Object.assign({ 'User-Agent': 'agent-orchestrator/1.0' }, headers) };
    https.get(url, opts, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Per-provider fetch functions — each returns string[] of raw model IDs.
// ---------------------------------------------------------------------------

// Fetch Anthropic /v1/models — endpoint requires `x-api-key` auth header.
// Why: prior version omitted the key and triggered `HTTP 401 from /v1/models`
// on every planning phase; mirror `fetchGeminiModels` by throwing early when
// the env var is absent so the caller silently falls through to static tiers.
async function fetchClaudeModels() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set — skipping live Claude fetch');
  const body = await httpsGet('https://api.anthropic.com/v1/models', {
    'anthropic-version': '2023-06-01',
    'x-api-key': key,
  });
  const json = JSON.parse(body);
  // Response shape: { data: [{ id: string, ... }] }
  const items = json.data || json.models || [];
  return items.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
}

// Fetches GitHub Models catalog — public endpoint, no auth required for listing.
async function fetchCopilotModels() {
  const body = await httpsGet('https://models.github.com/catalog', {
    'Accept': 'application/json',
  });
  const json = JSON.parse(body);
  // Catalog shape: array of model objects OR { models: [...] }
  const items = Array.isArray(json) ? json : (json.models || []);
  return items
    .map((m) => (typeof m === 'string' ? m : (m.id || m.name)))
    .filter(Boolean);
}

// Fetches Gemini model list via the generativelanguage REST API.
// Requires GEMINI_API_KEY env var; gracefully falls back if absent.
async function fetchGeminiModels() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set — skipping live Gemini fetch');
  const body = await httpsGet(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
  );
  const json = JSON.parse(body);
  // Shape: { models: [{ name: "models/gemini-2.5-pro", ... }] }
  return (json.models || [])
    .map((m) => (m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
}

// Gemini-Vertex uses same model IDs as public Gemini — reuse list.
async function fetchGeminiVertexModels() {
  return fetchGeminiModels();
}

const PROVIDER_FETCHERS = {
  'claude-code':    fetchClaudeModels,
  'github-copilot': fetchCopilotModels,
  'gemini':         fetchGeminiModels,
  'gemini-vertex':  fetchGeminiVertexModels,
};

// ---------------------------------------------------------------------------
// selectTiers — pure function; ranks model IDs into heavy/medium/light.
// Strategy: build a candidate list per tier via heuristics, then pick the
// lexicographically largest ID (highest version number) within each tier.
// ---------------------------------------------------------------------------
function selectTiers(models, providerId) {
  const rules = TIER_RULES[providerId] || TIER_RULES['claude-code'];
  const buckets = { heavy: [], medium: [], light: [] };

  for (const id of models) {
    const lower = id.toLowerCase();
    for (const { tier, pattern } of rules) {
      if (pattern.test(lower)) {
        buckets[tier].push(id);
        break;
      }
    }
  }

  // Compare model IDs numerically per segment so double-digit patch versions rank correctly
  // (e.g. 'claude-sonnet-4-10' > 'claude-sonnet-4-6'; lexicographic sort breaks at '1' < '6').
  function compareModelVersion(a, b) {
    const tokenize = s => s.match(/\d+|[^\d]+/g) || [];
    const at = tokenize(a), bt = tokenize(b);
    for (let i = 0; i < Math.max(at.length, bt.length); i++) {
      const x = at[i] || '', y = bt[i] || '';
      const xn = parseInt(x, 10), yn = parseInt(y, 10);
      const cmp = (!isNaN(xn) && !isNaN(yn)) ? (xn - yn) : (x < y ? -1 : x > y ? 1 : 0);
      if (cmp !== 0) return cmp;
    }
    return 0;
  }
  // Spread to avoid mutating the bucket (pick is called multiple times per bucket).
  const pick = (arr) => (arr.length ? [...arr].sort(compareModelVersion).pop() : null);

  const heavy  = pick(buckets.heavy)  || pick(buckets.medium) || pick(buckets.light);
  const medium = pick(buckets.medium) || heavy;
  const light  = pick(buckets.light)  || medium;

  return { heavy, medium, light };
}

// ---------------------------------------------------------------------------
// Cache read / write helpers.
// ---------------------------------------------------------------------------
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// fetchAndCache — invalidates the cache and re-fetches all providers.
// Exported for use by the `hrefresh-models` shell command.
// ---------------------------------------------------------------------------
async function fetchAndCache() {
  const providers = Object.keys(PROVIDER_FETCHERS);
  const cache = { fetchedAt: Date.now(), providers: {} };

  for (const pid of providers) {
    try {
      const models = await PROVIDER_FETCHERS[pid]();
      const tiers  = selectTiers(models, pid);
      cache.providers[pid] = { models, tiers };
      console.log(`[model-catalog] ${pid}: fetched ${models.length} models — heavy=${tiers.heavy} medium=${tiers.medium} light=${tiers.light}`);
    } catch (err) {
      console.warn(`[model-catalog] ${pid}: fetch failed (${err.message}) — provider omitted from cache`);
    }
  }

  writeCache(cache);
  console.log(`[model-catalog] cache written to ${CACHE_PATH}`);
  return cache;
}

// ---------------------------------------------------------------------------
// resolveProviderTiers — primary public API.
// Returns { light, medium, heavy } model IDs for the given providerId.
// Uses cache if fresh; fetches if stale or missing.
// opts.force = true bypasses TTL and forces a live fetch.
// ---------------------------------------------------------------------------
async function resolveProviderTiers(providerId, opts) {
  opts = opts || {};
  const fallback = STATIC_FALLBACKS[providerId] || STATIC_FALLBACKS['claude-code'];

  // --- 1. Try cache first (unless force refresh requested) ---
  if (!opts.force) {
    const cached = readCache();
    if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      const entry = cached.providers && cached.providers[providerId];
      if (entry && entry.tiers && entry.tiers.heavy) {
        return entry.tiers;
      }
    }
  }

  // --- 2. Fetch live, merge into cache, return result ---
  try {
    const fetcher = PROVIDER_FETCHERS[providerId];
    if (!fetcher) {
      console.warn(`[model-catalog] unknown provider "${providerId}" — using static fallback`);
      return fallback;
    }

    const models = await fetcher();
    const tiers  = selectTiers(models, providerId);

    // Merge this provider into the existing cache (preserve other providers).
    const existing = readCache() || { fetchedAt: Date.now(), providers: {} };
    existing.providers[providerId] = { models, tiers };
    existing.fetchedAt = existing.fetchedAt || Date.now();
    writeCache(existing);

    return tiers;
  } catch (err) {
    // Demoted from warn -> debug: missing API keys are an expected fallback path
    // (e.g. planning phase runs without ANTHROPIC_API_KEY) and the prior 401 noise
    // misled users into thinking the harness was broken.
    if (process.env.MODEL_CATALOG_DEBUG) {
      console.warn(`[model-catalog] live fetch failed for "${providerId}" (${err.message}) — using static fallback`);
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// isModelAvailable — synchronous cache lookup. Returns {available, knownList, stale}.
// Used by run-agent pre-flight to detect a configured model that the provider
// no longer exposes (e.g. typo `gpt-5.4`) so the caller can coerce to "auto".
// stale=true means cache is missing/expired/lacks the provider — caller should
// treat `available` as untrusted and either ensureFreshCache or skip the check.
// ---------------------------------------------------------------------------
function isModelAvailable(providerId, modelId) {
  const cached = readCache();
  if (!cached || !cached.providers || !cached.providers[providerId]) {
    return { available: false, knownList: [], stale: true };
  }
  const entry = cached.providers[providerId];
  const knownList = Array.isArray(entry.models) ? entry.models : [];
  const stale = !cached.fetchedAt || (Date.now() - cached.fetchedAt) >= CACHE_TTL_MS;
  const available = knownList.includes(modelId);
  return { available, knownList, stale };
}

// ---------------------------------------------------------------------------
// ensureFreshCache — guarantees the cache has a recent entry for providerId
// before the caller proceeds. Triggers `resolveProviderTiers` if missing/stale,
// bounded by syncTimeoutMs so we never block spawn on a slow network. On
// timeout/fetch failure returns {stale:true} so the caller can treat the
// availability check as inconclusive (do NOT block — fall through to existing
// behavior).
// ---------------------------------------------------------------------------
async function ensureFreshCache(providerId, opts) {
  opts = opts || {};
  const syncTimeoutMs = typeof opts.syncTimeoutMs === 'number' ? opts.syncTimeoutMs : 2500;
  const cached = readCache();
  const hasFresh = cached
    && cached.fetchedAt
    && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS
    && cached.providers
    && cached.providers[providerId]
    && Array.isArray(cached.providers[providerId].models)
    && cached.providers[providerId].models.length > 0;
  if (hasFresh) return { stale: false, refreshed: false };
  try {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`ensureFreshCache timeout after ${syncTimeoutMs}ms`)), syncTimeoutMs);
    });
    const tiers = await Promise.race([resolveProviderTiers(providerId), timeout]);
    clearTimeout(timer);
    return { stale: false, refreshed: true, tiers };
  } catch (err) {
    return { stale: true, refreshed: false, reason: err.message };
  }
}

// Synchronous lookup of the cached tier id for (providerId, tier). Used by
// the prompt-queue header tokenizer to map a family keyword (e.g. `opus`,
// `flash`) to a concrete cached model id without awaiting a fetch. Returns
// null when the cache is missing/empty or the requested tier is absent.
function getCachedTier(providerId, tier) {
  const cached = readCache();
  if (!cached || !cached.providers || !cached.providers[providerId]) return null;
  const tiers = cached.providers[providerId].tiers;
  if (!tiers || !tiers[tier]) return null;
  return tiers[tier];
}

module.exports = { resolveProviderTiers, fetchAndCache, selectTiers, isModelAvailable, ensureFreshCache, getCachedTier };
