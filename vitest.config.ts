import { defineConfig } from 'vitest/config';

export default defineConfig({
  // pouch.ts imports `pouchdb-browser` (which references browser globals like
  // `self` at module load). For Node-side tests we swap it for `pouchdb`,
  // the Node combo package — same PouchDB constructor API. Production builds
  // are not affected; esbuild bundles `pouchdb-browser` for real.
  resolve: {
    alias: {
      'pouchdb-browser': 'pouchdb',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Excluded: files that need the Obsidian runtime (App, TFile,
      // PluginSettingTab, requestUrl, setIcon, …) or a live CouchDB — exercised
      // by the E2E suite, not unit tests. The local PouchDB store (pouch.ts) and
      // the inbound apply/seed logic (inbound.ts) are dependency-free and unit-
      // tested against pouchdb-adapter-memory + a fake gateway.
      exclude: [
        '**/*.test.ts',
        '**/*.types.ts',
        'src/main.ts',
        'src/sync-controller.ts',
        'src/replication.ts',
        'src/status-bar.ts',
        'src/vault-watcher.ts',
        'src/push-note.ts',
        'src/obsidian-fetch.ts',
        'src/obsidian-vault-gateway.ts',
        'src/settings-tab.ts',
        'src/vault-events.ts',
      ],
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
});
