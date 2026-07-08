import { describe, it, expect, afterEach, vi } from 'vitest';
import { obsidianMockFactory } from '../fakes/obsidian';
vi.mock('obsidian', () => obsidianMockFactory());

import { bootReady, signIn, type Handles } from './_helpers';

// The management API (GET/POST /api/memories) behind the memory chooser. Lower risk than the
// sync path, but the entries->files mapping and the graceful "not available yet" degrade both
// surface directly in the chooser UI.

describe('memory management', () => {
  let h: Handles;
  afterEach(async () => h.teardown());

  it('14a. listVaults maps server memories to VaultInfo (entries -> files, empty flag)', async () => {
    h = await bootReady({
      memories: [
        { name: 'work', entries: 12, folderCount: 3, updated: '2026-07-08' },
        { name: 'blank', entries: 0, folderCount: 0, updated: null },
      ],
    });
    await signIn(h);

    const res = await h.plugin.listVaults();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byName = Object.fromEntries(res.vaults.map((v) => [v.name, v]));
    expect(byName.work).toMatchObject({
      files: 12,
      folders: 3,
      updated: '2026-07-08',
      empty: false,
    });
    expect(byName.blank).toMatchObject({ files: 0, folders: 0, empty: true }); // 0 entries -> empty
  });

  it('14b. createVault degrades to "not available yet" on 404 / 405 / 503', async () => {
    h = await bootReady({ memories: [] });
    await signIn(h);

    for (const status of [404, 405, 503]) {
      h.auth.failNextManagement(status);
      const r = await h.plugin.createVault('newmem');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not available on the server yet/i);
    }

    // A healthy POST still creates the memory (the degrade path is per-response, not sticky).
    const ok = await h.plugin.createVault('newmem');
    expect(ok.ok).toBe(true);
    expect(ok.vault).toBe('newmem');
  });
});
