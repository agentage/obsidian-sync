import { expect, test, type Page } from '@playwright/test';
import { launchObsidian } from './helpers/launch';
import { resetTestDb } from './helpers/couchdb';
import { dismissTrustAndAwaitSync, dumpFailureContext } from './helpers/session';

test.setTimeout(120_000);

const DEFAULT_HOST = 'https://sync.agentage.io';

/** Open the Agentage Memory plugin settings tab via Obsidian's settings API. */
async function openPluginSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setting = (window as any).app.setting;
    setting.open();
    setting.openTabById('agentage-memory');
  });
}

/** The latest Notice toast text (Obsidian renders `.notice` in a container). */
function latestNotice(page: Page) {
  return page.locator('.notice').last();
}

async function clickTest(page: Page): Promise<void> {
  await page
    .locator('.setting-item', { hasText: 'Test connection' })
    .getByRole('button', { name: 'Test', exact: true })
    .click();
}

test('Test connection reports Connected for a real CouchDB and "not configured" for the cloud default', async () => {
  const testInfo = test.info();
  await resetTestDb();
  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await dismissTrustAndAwaitSync(page);
    await openPluginSettings(page);

    const urlInput = page.locator('.setting-item', { hasText: 'Server URL' }).locator('input');
    await urlInput.waitFor({ state: 'visible', timeout: 15_000 });

    // 1. The seeded local CouchDB is reachable → Connected (HTTP 200).
    await clickTest(page);
    await expect(latestNotice(page)).toContainText('Connected (HTTP 200)', { timeout: 15_000 });

    // 2. Point it at the cloud default (not a CouchDB) → guidance, not a raw 404.
    await urlInput.fill(DEFAULT_HOST);
    await urlInput.blur();
    await clickTest(page);
    await expect(latestNotice(page)).toContainText('Not configured', { timeout: 15_000 });
    await expect(latestNotice(page)).not.toContainText('HTTP 404');
  } catch (err) {
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    await app.close();
  }
});
