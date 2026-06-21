import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30000, // git smart-HTTP round-trips spawn git-http-backend
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Excluded: Obsidian-runtime files (App/TFile/PluginSettingTab/setIcon),
      // the node-only test git server helper, and type/test files. The pure engine
      // (merge-note, stream-utils, resolve-host, vaults-config), the DI git-client
      // (against a real local git server), and the requestUrl HttpClient adapter
      // (against a mocked requestUrl) ARE unit/integration tested.
      exclude: [
        '**/*.test.ts',
        '**/*.types.ts',
        'src/main.ts',
        'src/settings-tab.ts',
        'src/memory-chooser.ts',
        'src/git/vault-fs.ts',
        'src/git/git-test-server.ts',
      ],
      thresholds: { branches: 70, functions: 70, lines: 70, statements: 70 },
    },
  },
});
