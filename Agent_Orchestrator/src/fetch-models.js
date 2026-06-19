'use strict';

// fetch-models.js — CLI entry point for `hfetch-models` shell function.
// Force-refreshes the .model-catalog-cache.json by fetching live model lists
// from all configured provider APIs and writing the result to disk.

const { fetchAndCache } = require('./lib/model-catalog');

(async () => {
  try {
    await fetchAndCache();
    process.exit(0);
  } catch (err) {
    console.error('[fetch-models] unexpected error:', err.message);
    process.exit(1);
  }
})();
