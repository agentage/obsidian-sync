import { expect, test, type Page } from '@playwright/test';
import { launchObsidian } from './helpers/launch';
import { deleteDoc, pollUntil, putDoc, resetTestDb } from './helpers/couchdb';
import { dismissTrustAndAwaitSync, dumpFailureContext } from './helpers/session';

test.setTimeout(120_000);
test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await resetTestDb();
});

/** Read a note's content from the renderer, or null if the file isn't there. */
async function vaultContent(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const file = w.app.vault.getAbstractFileByPath(p);
    if (!file) return null;
    return (await w.app.vault.read(file)) as string;
  }, path);
}

test('cloud write in CouchDB → note appears, updates, and deletes in Obsidian', async () => {
  const testInfo = test.info();
  const app = await launchObsidian();
  const path = 'e2e-inbound-target.md';
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await dismissTrustAndAwaitSync(page);

    // 1. A cloud client writes a brand-new note → it lands in the vault.
    await putDoc(path, '# from the cloud');
    await pollUntil(async () => (await vaultContent(page, path)) === '# from the cloud', {
      timeoutMs: 20_000,
      label: 'inbound create reached the vault',
    });

    // 2. The same note is edited in the cloud → the vault file updates.
    await putDoc(path, '# edited in the cloud');
    await pollUntil(async () => (await vaultContent(page, path)) === '# edited in the cloud', {
      timeoutMs: 20_000,
      label: 'inbound update reached the vault',
    });

    // 3. The note is deleted in the cloud → the vault file is trashed.
    await deleteDoc(path);
    await pollUntil(async () => (await vaultContent(page, path)) === null, {
      timeoutMs: 20_000,
      label: 'inbound delete removed the vault file',
    });

    expect(await vaultContent(page, path)).toBeNull();
  } catch (err) {
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    await app.close();
  }
});
