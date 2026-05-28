import type { Page, TestInfo } from '@playwright/test';
import type { ObsidianHandle } from './launch';
import { pollUntil } from './couchdb';

const STATUS_ICON = '.agentage-memory-status-icon';

/**
 * Click through the first-open "Do you trust the author of this vault?" modal
 * (it gates the community plugin from loading) and wait until the plugin
 * reports a settled sync, so a test can act on a live two-way replica.
 */
export async function dismissTrustAndAwaitSync(page: Page): Promise<void> {
  const trustBtn = page
    .locator('.mod-cta, button')
    .filter({ hasText: /Trust author and enable plugins/i });
  try {
    await trustBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await trustBtn.click();
  } catch {
    // modal not shown (vault already trusted) — fine.
  }

  const icon = page.locator(STATUS_ICON).first();
  await icon.waitFor({ timeout: 30_000 });
  await pollUntil(async () => (await icon.getAttribute('data-status')) === 'synced', {
    timeoutMs: 30_000,
    label: 'plugin status === synced',
  });
}

/** On failure, attach a screenshot + log plugin state so CI logs explain it. */
export async function dumpFailureContext(app: ObsidianHandle, testInfo: TestInfo): Promise<void> {
  const page = app.context.pages()[0];
  if (!page) return;
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) await testInfo.attach('failure.png', { body: buf, contentType: 'image/png' });
  const statusAttr = await page
    .locator(STATUS_ICON)
    .first()
    .getAttribute('data-status')
    .catch(() => null);
  const enabledPlugins = await page
    .evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ids = ((window as any).app?.plugins?.enabledPlugins ?? new Set()) as Set<string>;
      return Array.from(ids);
    })
    .catch(() => null);
  console.error('[e2e] failure context:', { statusAttr, enabledPlugins });
}
