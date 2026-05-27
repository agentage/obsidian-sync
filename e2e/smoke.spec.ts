import { expect, test } from '@playwright/test';
import { launchObsidian } from './helpers/launch';

/**
 * Smoke test: prove Playwright can launch the Obsidian binary and read its
 * top-level window state. Plugin-behaviour assertions (status-bar contents,
 * command-palette execution, end-to-end sync flow) build on top of this in
 * follow-up specs.
 */
test('Obsidian launches under Playwright and exposes a renderer window', async () => {
  const app = await launchObsidian();
  try {
    const window = await app.firstWindow();
    expect(window).toBeDefined();
    await window.waitForLoadState('domcontentloaded');
    const title = (await window.title()).toLowerCase();
    expect(title).toContain('obsidian');
  } finally {
    await app.close();
  }
});
