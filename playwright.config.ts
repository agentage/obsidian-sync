import { defineConfig } from '@playwright/test';

/**
 * Playwright Electron config for desktop-app E2E tests against Obsidian.
 *
 * We do NOT install browsers (`npx playwright install`) — these tests only
 * drive the Obsidian Electron binary, not a browser. Resolution of the
 * binary is in `e2e/helpers/launch.ts`.
 *
 * Run locally:  npm run test:e2e
 * Skip in CI:   E2E is opt-in until we can install Obsidian inside the
 *               GitHub Actions runner (separate PR).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
});
