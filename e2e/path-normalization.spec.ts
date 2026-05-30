import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchObsidian } from './helpers/launch';
import { pollUntil, putDoc, resetTestDb } from './helpers/couchdb';
import { dismissTrustAndAwaitSync, dumpFailureContext } from './helpers/session';

test.setTimeout(120_000);
test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await resetTestDb();
});

const VAULT = process.env.OBSIDIAN_VAULT ?? '/tmp/obsidian-test-vault';

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

test('hostile cloud _ids are normalized and cannot escape the vault', async () => {
  const testInfo = test.info();
  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await dismissTrustAndAwaitSync(page);

    // A cloud writer pushes docs with hostile _ids straight into CouchDB.
    await putDoc('/notes//e2e-norm-leading.md', '# leading'); // leading + doubled slash
    await putDoc('e2e-norm-dir\\nested\\bs.md', '# backslash'); // windows-style separators
    await putDoc('../e2e-norm-escape.md', '# escape'); // path traversal
    // A well-formed sentinel last: once it lands, the feed has processed the rest.
    await putDoc('e2e-norm-sentinel.md', '# sentinel');

    await pollUntil(async () => (await vaultContent(page, 'e2e-norm-sentinel.md')) === '# sentinel', {
      timeoutMs: 30_000,
      label: 'sentinel note reached the vault',
    });

    // Leading/doubled slashes are stripped — the note lands at the clean path,
    // and the raw _id is NOT a file.
    expect(await vaultContent(page, 'notes/e2e-norm-leading.md')).toBe('# leading');
    expect(await vaultContent(page, '/notes//e2e-norm-leading.md')).toBeNull();

    // Backslashes become forward slashes.
    expect(await vaultContent(page, 'e2e-norm-dir/nested/bs.md')).toBe('# backslash');

    // The traversal doc is refused: nothing inside the vault, nothing above it.
    expect(await vaultContent(page, 'e2e-norm-escape.md')).toBeNull();
    expect(existsSync(resolve(VAULT, '..', 'e2e-norm-escape.md'))).toBe(false);
  } catch (err) {
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    await app.close();
  }
});
