import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30000, // git smart-HTTP round-trips spawn git-http-backend
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Excluded: Obsidian-runtime files (App/TFile/PluginSettingTab/setIcon/Vault +
      // window/crypto.subtle), the node-only test git server helper, and type/test files.
      // The pure engine (merge-note, stream-utils, resolve-host, vaults-config), the couch
      // discovery + token flow (resolve-host, couch-token), the couch doc model + persisted
      // sync state (couch-doc, couch-state), the DI git-client (against a real local git
      // server), and the requestUrl HttpClient adapter (against a mocked requestUrl) ARE
      // unit/integration tested. couch-sync is the Vault/requestUrl-coupled replication driver
      // (same bucket as vault-fs; exercised by couch-sync.test.ts); doc model matches the bridge.
      exclude: [
        '**/*.test.ts',
        '**/*.types.ts',
        'src/main.ts',
        'src/settings-tab.ts',
        'src/memory-chooser.ts',
        'src/actions-menu.ts',
        'src/git/vault-fs.ts',
        'src/git/git-test-server.ts',
        'src/couch/couch-sync.ts',
      ],
      thresholds: { branches: 70, functions: 70, lines: 70, statements: 70 },
    },
  },
});
