#!/usr/bin/env node
'use strict';

const generator = require('./lib/providers/agents-md-generator');

function log(msg) { console.log(`[sync-user-native-config] ${msg}`); }
function fail(msg) { console.error(`[sync-user-native-config] ERROR: ${msg}`); }

try {
  const result = generator.syncUserNativeConfig();
  for (const filePath of result.writtenFiles) {
    log(`Synced ${result.sourceFilePath} -> ${filePath}`);
  }
  if (result.removedLegacyAgentsPath) {
    log(`Removed legacy VS Code AGENTS.md from old sync flow: ${result.removedLegacyAgentsPath}`);
  }
} catch (err) {
  fail(err && err.message ? err.message : String(err));
  process.exit(1);
}
