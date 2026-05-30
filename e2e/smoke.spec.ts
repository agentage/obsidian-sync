import { expect, test } from '@playwright/test';
import { launchObsidian } from './helpers/launch';

test.setTimeout(60_000);

test('Obsidian opens the test vault and renders its main window', async () => {
  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const title = (await page.title()).toLowerCase();
    expect(title).toContain('obsidian');
  } finally {
    await app.close();
  }
});
