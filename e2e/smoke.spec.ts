import { expect, test } from '@playwright/test';
import { launchObsidian } from './helpers/launch';

test.setTimeout(180_000);

test('Obsidian launches under Playwright and exposes a renderer window', async () => {
  const app = await launchObsidian();
  try {
    const window = await app.firstWindow({ timeout: 120_000 });
    expect(window).toBeDefined();
    await window.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    const title = (await window.title()).toLowerCase();
    expect(title).toContain('obsidian');
  } finally {
    await app.close();
  }
});
