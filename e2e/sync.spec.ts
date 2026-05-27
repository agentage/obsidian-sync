import { expect, test } from '@playwright/test';
import { launchObsidian } from './helpers/launch';
import { docStatus, pollUntil, resetTestDb } from './helpers/couchdb';

test.setTimeout(120_000);
test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await resetTestDb();
});

test('delete in Obsidian → tombstone replicates to CouchDB', async () => {
  const testInfo = test.info();
  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // First-open "Do you trust the author of this vault?" modal gates the
    // community plugin from loading. Click through if present — smoke spec
    // doesn't need this (title is set even with the modal up), but sync does.
    const trustBtn = page
      .locator('.mod-cta, button')
      .filter({ hasText: /Trust author and enable plugins/i });
    try {
      await trustBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await trustBtn.click();
    } catch {
      // modal not shown (vault already trusted) — fine.
    }

    // 1. Plugin loaded? — the status-bar icon span exists for any state.
    const icon = page.locator('.agentage-memory-status-icon').first();
    await icon.waitFor({ timeout: 30_000 });

    // 2. Sync settled to 'synced' — proves replication round-tripped.
    await pollUntil(
      async () => (await icon.getAttribute('data-status')) === 'synced',
      { timeoutMs: 30_000, label: 'plugin status === synced' }
    );

    // 3. Create a fresh note from the renderer (also exercises auto-push).
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).app.vault.create('e2e-delete-target.md', '# delete me');
    });
    await pollUntil(async () => (await docStatus('e2e-delete-target.md')) === 200, {
      timeoutMs: 15_000,
      label: 'create replicated to CouchDB',
    });

    // 4. Delete it from Obsidian.
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const file = w.app.vault.getAbstractFileByPath('e2e-delete-target.md');
      await w.app.vault.delete(file);
    });
    await pollUntil(async () => (await docStatus('e2e-delete-target.md')) === 404, {
      timeoutMs: 15_000,
      label: 'tombstone replicated to CouchDB',
    });

    expect(await docStatus('e2e-delete-target.md')).toBe(404);
  } catch (err) {
    // On any failure, dump what's on screen so CI logs explain it.
    const page = app.context.pages()[0];
    if (page) {
      const buf = await page.screenshot({ fullPage: true });
      await testInfo.attach('failure.png', { body: buf, contentType: 'image/png' });
      const status = await page
        .locator('.agentage-memory-status-icon')
        .first()
        .getAttribute('data-status')
        .catch(() => null);
      const enabledPlugins = await page
        .evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ids = Array.from(((window as any).app?.plugins?.enabledPlugins ?? new Set()) as Set<string>);
          return ids;
        })
        .catch(() => null);
      console.error('[sync.spec] failure context:', {
        statusAttr: status,
        enabledPlugins,
      });
    }
    throw err;
  } finally {
    await app.close();
  }
});
