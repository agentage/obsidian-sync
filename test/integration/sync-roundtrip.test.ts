import { describe, it, expect, afterEach, vi } from 'vitest';
import { obsidianMockFactory } from '../fakes/obsidian';
vi.mock('obsidian', () => obsidianMockFactory());

import { bootSignedIn, seedRemote, edit, settle, drain, type Handles } from './_helpers';

// The two-way live loop: a local edit pushes leaf-then-file, a remote change pulls into the
// vault, and the just-pulled content does not echo straight back out as a redundant push.

describe('live sync round-trip', () => {
  let h: Handles;
  afterEach(async () => h.teardown());

  it('4. local edit -> live push writes leaves via _bulk_docs then the file doc via PUT', async () => {
    h = await bootSignedIn();
    await h.plugin.syncNow(); // warm the controller + cursor

    h.router.reset();
    edit(h, 'note.md', 'fresh local body');
    await settle(() => h.couch.fileDoc('note.md') !== undefined);

    // The wire order that matters: leaves land first (_bulk_docs), then the file doc (PUT), so
    // the file doc never references a leaf couch has not stored yet.
    const writes = h.router.calls.filter((c) => c.method === 'POST' || c.method === 'PUT');
    const bulkIdx = writes.findIndex((c) => c.url.includes('/_bulk_docs'));
    const putIdx = writes.findIndex((c) => c.method === 'PUT' && c.url.includes('note.md'));
    expect(bulkIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(bulkIdx);

    // Couch state agrees: the file doc + its single content leaf both exist server-side.
    const doc = h.couch.fileDoc('note.md');
    expect(doc?.size).toBe('fresh local body'.length);
    expect(doc?.leaves.every((id) => h.couch.hasLeaf(id))).toBe(true);
  });

  it('5. remote change pulls into the vault; the applied content does not echo back as a push', async () => {
    h = await bootSignedIn();
    await seedRemote(h, 'incoming.md', 'from another device');

    const r = await h.plugin.syncNow();
    expect(r.ok).toBe(true);
    expect(h.vault.content('incoming.md')).toBe('from another device');

    // A 'modify' event now fires for the just-pulled file with the SAME content (as the OS file
    // watcher would after our own write). The suppress guard + the content-rev cache skip it:
    // no _bulk_docs / PUT for incoming.md - the pull does not bounce back out.
    h.router.reset();
    edit(h, 'incoming.md', 'from another device');
    await drain(); // give the (skipped) echo push every chance to reach the network
    const echoes = h.router.calls.filter(
      (c) => c.method !== 'GET' && c.url.includes('incoming.md')
    );
    const bulk = h.router.calls.filter((c) => c.method === 'POST' && c.url.includes('_bulk_docs'));
    expect(echoes).toEqual([]);
    expect(bulk).toEqual([]);
  });
});
