import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchObsidian } from './helpers/launch';
import { dumpFailureContext } from './helpers/session';

test.setTimeout(120_000);

const VAULT = process.env.OBSIDIAN_VAULT ?? '/tmp/obsidian-test-vault';
const DATA_JSON = join(VAULT, '.obsidian', 'plugins', 'agentage-memory', 'data.json');
const STATUS_ICON = '.agentage-memory-status-icon';
const DEFAULT_HOST = 'https://memory.agentage.io';
const NETWORKED = ['active', 'synced', 'error'];

/**
 * Developer-Policy proof (T14): a fresh / signed-out install must make zero
 * unsolicited network calls on load. We swap the configured data.json for an
 * unconfigured one (default cloud host, NO credentials) — exactly a fresh
 * install — and assert the status icon settles at `idle` and never transitions
 * to a networked state (`active`/`synced`/`error`), which would mean the plugin
 * opened a replication connection. The original data.json is restored so the
 * configured specs are unaffected.
 */
test('fresh signed-out install (default host, no creds) opens no sync connection on load', async () => {
  const testInfo = test.info();
  const original = existsSync(DATA_JSON) ? readFileSync(DATA_JSON, 'utf8') : null;
  // Unconfigured: default API/OAuth host, no username/password, no sign-in.
  writeFileSync(
    DATA_JSON,
    JSON.stringify({ serverUrl: DEFAULT_HOST, dbName: 'agentage-memory' }, null, 2)
  );

  const app = await launchObsidian();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Enable the plugin past the trust gate.
    const trustBtn = page
      .locator('.mod-cta, button')
      .filter({ hasText: /Trust author and enable plugins/i });
    try {
      await trustBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await trustBtn.click();
    } catch {
      // already trusted
    }

    const icon = page.locator(STATUS_ICON).first();
    await icon.waitFor({ timeout: 30_000 });

    // The gate keeps replication off → status settles at `idle`.
    await expect
      .poll(async () => icon.getAttribute('data-status'), { timeout: 15_000 })
      .toBe('idle');

    // And stays gated off: watch for 8s that it never opens a connection.
    for (let i = 0; i < 8; i++) {
      const status = await icon.getAttribute('data-status');
      expect(NETWORKED, `status flipped to "${status}" — a connection was opened`).not.toContain(
        status
      );
      await page.waitForTimeout(1000);
    }
  } catch (err) {
    await dumpFailureContext(app, testInfo);
    throw err;
  } finally {
    if (original !== null) writeFileSync(DATA_JSON, original);
    await app.close();
  }
});
