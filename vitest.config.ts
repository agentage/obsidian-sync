import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30000, // couch replication tests exercise retry/backoff timing
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Excluded: Obsidian-runtime files (App/TFile/PluginSettingTab/setIcon/Vault +
      // window/crypto.subtle) and type/test files. The pure engine (merge-note, stream-utils,
      // resolve-host, vaults-config), the couch discovery + token flow (resolve-host,
      // couch-token), and the couch doc model + persisted sync state (couch-doc, couch-state)
      // ARE unit-tested. couch-sync is the Vault/requestUrl-coupled replication driver, excluded
      // like the other Obsidian-coupled entry points; exercised by couch-sync.test.ts.
      exclude: [
        '**/*.test.ts',
        '**/*.types.ts',
        'src/main.ts',
        'src/settings-tab.ts',
        'src/memory-chooser.ts',
        'src/actions-menu.ts',
        'src/couch/couch-sync.ts',
      ],
      thresholds: { branches: 70, functions: 70, lines: 70, statements: 70 },
    },
  },
});
