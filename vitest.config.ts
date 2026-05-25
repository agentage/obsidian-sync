import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts is the Obsidian entry point — it needs the Obsidian runtime,
      // so it is exercised in the app, not in unit tests.
      exclude: ['**/*.test.ts', 'src/main.ts'],
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
});
