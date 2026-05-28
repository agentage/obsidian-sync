import { expect, test } from '@playwright/test';
import { launchObsidian } from './helpers/launch';
import { docStatus, pollUntil, resetTestDb } from './helpers/couchdb';
import { dismissTrustAndAwaitSync, dumpFailureContext } from './helpers/session';

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
    await dismissTrustAndAwaitSync(page);

    // 1. Create a fresh note from the renderer (also exercises auto-push).
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).app.vault.create('e2e-delete-target.md', '# delete me');
    });
    await pollUntil(async () => (await docStatus('e2e-delete-target.md')) === 200, {
      timeoutMs: 15_000,
      label: 'create replicated to CouchDB',
    });

    // 2. Delete it from Obsidian → tombstone replicates upstream.
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
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    await app.close();
  }
});
