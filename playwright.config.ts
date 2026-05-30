import { defineConfig } from '@playwright/test';

/**
 * Playwright Electron config for desktop-app E2E tests against Obsidian.
 *
 * We do NOT install browsers (`npx playwright install`) — these tests only
 * drive the Obsidian Electron binary, not a browser. Resolution of the
 * binary is in `e2e/helpers/launch.ts`.
 *
 * Run locally:  npm run test:e2e
 * In CI:        runs on every PR — pr-validation.yml installs Obsidian into the
 *               runner and drives Playwright under xvfb.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
});
