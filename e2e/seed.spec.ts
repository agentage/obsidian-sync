import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchObsidian } from './helpers/launch';
import { getDoc, pollUntil, resetTestDb } from './helpers/couchdb';
import { dismissTrustAndAwaitSync, dumpFailureContext } from './helpers/session';

test.setTimeout(120_000);
test.describe.configure({ mode: 'serial' });

const VAULT = process.env.OBSIDIAN_VAULT ?? '/tmp/obsidian-test-vault';

test('pre-existing vault note is seeded to CouchDB on first connect', async () => {
  const testInfo = test.info();
  const path = 'e2e-seed-existing.md';
  const body = '# I existed before the plugin loaded';

  // Write the note to disk *before* Obsidian launches, so it's a pre-existing
  // file: the on-load create event is skipped by the layout-ready guard, so the
  // only way it reaches the cloud is the seed pass.
  await writeFile(join(VAULT, path), body, 'utf8');
  await resetTestDb();

  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await dismissTrustAndAwaitSync(page);

    await pollUntil(async () => (await getDoc(path))?.content === body, {
      timeoutMs: 20_000,
      label: 'pre-existing note seeded to CouchDB',
    });

    expect((await getDoc(path))?.content).toBe(body);
  } catch (err) {
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    await app.close();
  }
});
