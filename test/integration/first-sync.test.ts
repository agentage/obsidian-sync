import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { obsidianMockFactory } from '../fakes/obsidian';

// The whole plugin import graph resolves 'obsidian' to the harness mock (class bases +
// Platform + the requestUrl spy). Everything else the plugin uses is injected via the fake
// app + the Router behind requestUrl - no real Obsidian binary, no network.
vi.mock('obsidian', () => obsidianMockFactory());

import { bootPlugin, signIn, type Handles } from '../fakes/boot';

describe('first-sync smoke: connect -> pick memory -> seed vault -> zero-HTTP re-sync', () => {
  let h: Handles;

  beforeEach(async () => {
    // The server already holds one couch-channel memory 'work' with a seeded note, so the
    // first sync PULLS remote content into an empty local vault (the wedge first-run flow).
    h = await bootPlugin({
      files: {},
      memoryName: 'work',
      couchDb: 'mem_work',
      memories: [{ name: 'work', entries: 1, folderCount: 0, updated: '2026-07-08' }],
    });
    h.couch.injectRemoteChange('welcome.md', 'Hello from the cloud', [
      { _id: 'h:seed', _rev: '1-seed', data: 'Hello from the cloud' },
    ]);
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('signs in, selects the memory, first-syncs the seed note, then re-syncs with no HTTP', async () => {
    // 1. Not signed in at boot.
    expect(h.plugin.isSignedIn()).toBe(false);

    // 2. Connect: discovery -> DCR -> authorize -> code exchange (all through the router).
    await signIn(h);
    expect(h.plugin.isSignedIn()).toBe(true);

    // 3. Pick the memory + run the first sync (selectVault triggers autoSyncOnReady).
    await h.plugin.selectVault('work');
    const result = await h.plugin.syncNow();

    // 4. First sync succeeded and seeded the local vault from couch.
    expect(result.ok).toBe(true);
    expect(h.vault.content('welcome.md')).toBe('Hello from the cloud');
    expect(h.vault.paths()).toEqual(['welcome.md']);

    // 5. Fake-couch state agrees: the seeded file doc + its leaf exist server-side.
    expect(h.couch.filePaths()).toEqual(['welcome.md']);
    expect(h.couch.hasLeaf('h:seed')).toBe(true);

    // 6. Re-sync with nothing changed does ZERO write HTTP: the push rev-cache + pull cursor
    //    are warm, so the only traffic is the single empty _changes poll (no PUT/POST/DELETE).
    h.router.reset();
    const again = await h.plugin.syncNow();
    expect(again.ok).toBe(true);
    const writes = h.router.calls.filter((c) => c.method !== 'GET');
    expect(writes).toEqual([]);
    // The one GET is the empty _changes poll, and it advertises the caught-up cursor.
    const changes = h.router.calls.filter((c) => c.url.includes('/_changes'));
    expect(changes).toHaveLength(1);
    expect(changes[0].url).toContain(`since=${h.couch.lastSeq()}`);
  });
});
