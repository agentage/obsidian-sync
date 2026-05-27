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
      // Files that need the Obsidian runtime (App, TFile, PluginSettingTab,
      // requestUrl, …) — exercised via the E2E suite, not unit tests.
      // pouch.ts wraps pouchdb-browser/IndexedDB; the engine itself is
      // covered by pouch.test.ts against pouchdb-adapter-memory.
      exclude: [
        '**/*.test.ts',
        'src/main.ts',
        'src/pouch.ts',
        'src/apply-doc.ts',
        'src/obsidian-fetch.ts',
        'src/settings-tab.ts',
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
