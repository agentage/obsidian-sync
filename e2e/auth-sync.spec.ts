import { expect, test, type Page } from '@playwright/test';
import { launchObsidian } from './helpers/launch';
import { dumpFailureContext } from './helpers/session';

test.setTimeout(120_000);

/**
 * Authed cloud-sync proof (T09). Skipped until the backend `/api/sync/bootstrap`
 * endpoint exists — set `BOOTSTRAP_URL` to enable. When the endpoint is live,
 * this signs in, lets the controller trade the account token for a per-tenant
 * `{syncUrl, dbName, token}`, and asserts replication rides a `Bearer` token to
 * the bootstrapped target (status reaches `synced`, no stored CouchDB password).
 *
 * Until then the bootstrap path is covered by unit tests (bootstrap.test.ts,
 * auth.test.ts `bearerAuthProvider`); the signed-OUT fallback to the local Basic
 * path is exercised by the rest of the e2e suite (it must stay green — bootstrap
 * is null when not signed in, so sync still uses settings + creds).
 */
const BOOTSTRAP_URL = process.env.BOOTSTRAP_URL;

test.skip(!BOOTSTRAP_URL, 'set BOOTSTRAP_URL once /api/sync/bootstrap is deployed');

test('signed-in sync rides a bootstrapped bearer token (no stored password)', async () => {
  const testInfo = test.info();
  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // Placeholder until the endpoint is deployed: the real flow signs in via the
    // OAuth callback, waits for the bootstrap, then asserts a Bearer-authed
    // replication settles `synced` against the per-tenant syncUrl.
    expect(BOOTSTRAP_URL).toBeTruthy();
    await assertSignedInSyncSettles(page, BOOTSTRAP_URL as string);
  } catch (err) {
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    await app.close();
  }
});

// Intentionally unimplemented until the backend lands; the test is skipped, so
// this is never reached. Kept as the explicit contract the endpoint must satisfy.
async function assertSignedInSyncSettles(_page: Page, _bootstrapUrl: string): Promise<void> {
  throw new Error('auth-sync e2e not yet implemented — backend /api/sync/bootstrap pending');
}
