import { readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { injectConflict, pollUntil, putDoc, resetTestDb } from './helpers/couchdb';
import { launchObsidian } from './helpers/launch';
import { dismissTrustAndAwaitSync, dumpFailureContext } from './helpers/session';

test.setTimeout(120_000);
test.describe.configure({ mode: 'serial' });

const VAULT = process.env.OBSIDIAN_VAULT ?? '/tmp/obsidian-test-vault';
const PARENT = resolve(VAULT, '..');
const ESCAPE_RE = /e2e-sidecar-escape\.conflict-.*\.md/;

/** Any escape sidecar that leaked into the vault's parent directory. */
function parentLeaks(): string[] {
  return readdirSync(PARENT).filter((f) => ESCAPE_RE.test(f));
}

function cleanLeaks(): void {
  for (const f of parentLeaks()) rmSync(resolve(PARENT, f), { force: true });
}

test.beforeEach(async () => {
  await resetTestDb();
  cleanLeaks(); // remove any leak from a prior run so the assertion is clean
});

test.afterEach(() => cleanLeaks());

/** Content of the `<base>.conflict-*.md` sidecar inside the vault, or null. */
async function sidecarContent(page: Page, base: string): Promise<string | null> {
  return page.evaluate(async (b) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const stem = b.replace(/\.md$/, '');
    const re = new RegExp(`${stem}\\.conflict-.+\\.md$`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = w.app.vault.getMarkdownFiles().find((f: any) => re.test(f.path));
    return file ? ((await w.app.vault.read(file)) as string) : null;
  }, base);
}

/**
 * Real path-traversal proof (T16/M5). A hostile cloud `_id` ("../escape.md")
 * edited concurrently produces a losing revision whose sidecar path is
 * "../escape.conflict-*.md". Obsidian's `vault.create` does NOT sandbox `..`,
 * so without the inbound guard the loser is written to the vault's PARENT
 * directory (proven: pre-fix this test fails with a leaked file in PARENT). The
 * guard normalizes the sidecar path and refuses any `..` segment.
 *
 * The escape write is async, so we assert continuously across the processing
 * window: a benign sentinel conflict (higher change-seq) is pushed last; once
 * its sidecar materialises the hostile conflict has been fed, and we keep
 * checking for ~8s that no leak ever appears.
 */
test('a conflict on a hostile _id never escapes the vault via its sidecar', async () => {
  const testInfo = test.info();
  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await dismissTrustAndAwaitSync(page);

    // Hostile conflict first (lower change-seq), benign sentinel conflict last.
    await putDoc('../e2e-sidecar-escape.md', 'ESCAPE_BASE');
    await injectConflict('../e2e-sidecar-escape.md', 'ESCAPE_LOSER');
    await putDoc('e2e-sidecar-sentinel.md', 'SENTINEL_A');
    await injectConflict('e2e-sidecar-sentinel.md', 'SENTINEL_B');

    // Once the sentinel's sidecar exists, the hostile conflict has been fed too.
    await pollUntil(async () => (await sidecarContent(page, 'e2e-sidecar-sentinel.md')) !== null, {
      timeoutMs: 30_000,
      label: 'benign sentinel sidecar materialised',
    });

    // Assert no leak appears at any point over the next ~8s (async applies flush
    // here; pre-fix the leak lands inside this window, post-fix it never does).
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      expect(parentLeaks(), `escape sidecar leaked into ${PARENT}`).toEqual([]);
      await page.waitForTimeout(250);
    }
    // And nothing landed inside the vault either, while benign sync still worked.
    expect(await sidecarContent(page, '../e2e-sidecar-escape.md')).toBeNull();
  } catch (err) {
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    await app.close();
  }
});
