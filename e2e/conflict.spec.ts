import { expect, test, type Page } from '@playwright/test';
import { injectConflict, pollUntil, putDoc, resetTestDb } from './helpers/couchdb';
import { launchObsidian } from './helpers/launch';
import { dismissTrustAndAwaitSync, dumpFailureContext } from './helpers/session';

test.setTimeout(120_000);
test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await resetTestDb();
});

/** Read a note's content from the renderer, or null if absent. */
async function vaultContent(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const file = w.app.vault.getAbstractFileByPath(p);
    return file ? ((await w.app.vault.read(file)) as string) : null;
  }, path);
}

/** Content of the `<base>.conflict-*.md` sidecar, or null if not yet created. */
async function sidecarContent(page: Page, base: string): Promise<string | null> {
  return page.evaluate(async (b) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const stem = b.replace(/\.md$/, '');
    const re = new RegExp(`^${stem}\\.conflict-.+\\.md$`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = w.app.vault.getMarkdownFiles().find((f: any) => re.test(f.path));
    return file ? ((await w.app.vault.read(file)) as string) : null;
  }, base);
}

test('concurrent-edit conflict keeps both versions (winner + sidecar)', async () => {
  const testInfo = test.info();
  const path = 'e2e-conflict.md';
  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await dismissTrustAndAwaitSync(page);

    // Seed a note from the cloud so the replica holds it at generation 1.
    await putDoc(path, 'ORIGINAL_A');
    await pollUntil(async () => (await vaultContent(page, path)) === 'ORIGINAL_A', {
      timeoutMs: 20_000,
      label: 'base note pulled into the vault',
    });

    // A second client edits the same note concurrently → a real conflict.
    await injectConflict(path, 'CONFLICT_B');

    // The losing edit is preserved as a sidecar; neither version is lost.
    await pollUntil(async () => (await sidecarContent(page, path)) !== null, {
      timeoutMs: 20_000,
      label: 'conflict sidecar materialised',
    });

    const both = [await vaultContent(page, path), await sidecarContent(page, path)].sort();
    expect(both).toEqual(['CONFLICT_B', 'ORIGINAL_A']);
  } catch (err) {
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    await app.close();
  }
});
