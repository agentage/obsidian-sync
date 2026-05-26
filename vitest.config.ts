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
      // main.ts is the Obsidian entry point — it needs the Obsidian runtime,
      // so it is exercised in the app, not in unit tests. pouch.ts wraps
      // pouchdb-browser (IndexedDB) and is exercised against a live CouchDB;
      // unit tests come back when pouchdb-adapter-memory is wired up.
      exclude: ['**/*.test.ts', 'src/main.ts', 'src/pouch.ts'],
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
});
