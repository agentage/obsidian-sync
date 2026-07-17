import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { obsidianMockFactory } from '../fakes/obsidian';

// The plugin import graph resolves 'obsidian' to the harness mock; everything else is injected
// via the fake app + the Router behind requestUrl. See test/integration/first-sync.test.ts.
vi.mock('obsidian', () => obsidianMockFactory());

import { bootPlugin, signIn, type Handles } from '../fakes/boot';
import type { SyncPreview } from '../../src/sync-preview-modal';

// The sync popup's count comes from the private previewSync(); expose it via a cast (same pattern
// the signIn helper uses to reach auth.handleCallback).
const preview = (h: Handles): Promise<SyncPreview> =>
  (h.plugin as unknown as { previewSync(): Promise<SyncPreview> }).previewSync();

describe('sync-preview count is honest on a FRESH memory (the first-sync bug)', () => {
  let h: Handles;

  beforeEach(async () => {
    // A fresh couch-channel memory 'work' the CLOUD side is EMPTY for, while the LOCAL vault
    // already has three markdown notes - the exact repro: first sync must push all three.
    h = await bootPlugin({
      files: { 'a.md': 'Alpha', 'b.md': 'Bravo', 'notes/c.md': 'Charlie' },
      memoryName: 'work',
      couchDb: 'mem_work',
      memories: [{ name: 'work', entries: 0, folderCount: 0, updated: null }],
    });
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('reports N (not 0) before the first push, then 0 after a full sync', async () => {
    await signIn(h);
    await h.plugin.selectVault('work');

    // BEFORE any sync: the honest outgoing count is every local md file, NOT 0 (the old bug read
    // the failed-push retry queue, which is empty on a fresh pick and reported "0 to send").
    const before = await preview(h);
    expect(before.firstSync).toBe(false);
    expect(before.outgoing).toBe(3);

    // Run the real sync (pushes all three to the fake couch).
    const result = await h.plugin.syncNow();
    expect(result.ok).toBe(true);
    expect(h.couch.filePaths()).toEqual(['a.md', 'b.md', 'notes/c.md']);

    // AFTER a full sync: the push-rev cache is warm, so the preview honestly reports nothing to send.
    const after = await preview(h);
    expect(after.outgoing).toBe(0);
  });

  it('firstSync=true when no memory is chosen yet', async () => {
    await signIn(h);
    // Signed in but selectVault not called -> nothing to preview.
    const p = await preview(h);
    expect(p.firstSync).toBe(true);
    expect(p.outgoing).toBe(0);
  });
});
