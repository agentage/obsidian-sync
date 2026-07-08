import { describe, it, expect, afterEach, vi } from 'vitest';
import { obsidianMockFactory } from '../fakes/obsidian';
vi.mock('obsidian', () => obsidianMockFactory());

import type { LeafDoc } from '../../src/couch/couch-doc';
import { bootSignedIn, seedRemote, del, settle, drain, tick, type Handles } from './_helpers';

// Data-loss guards - the highest-risk journeys. Every assertion checks BOTH vault state and
// fake-couch state so a truncation or a phantom deletion can't hide behind a green push count.

describe('delete + conflict data-loss guards', () => {
  let h: Handles;
  afterEach(async () => h.teardown());

  // A two-leaf remote note we can partially break: dropping one leaf makes reassemble throw.
  const twoLeafNote = (
    path: string,
    a: string,
    b: string
  ): { leaves: LeafDoc[]; full: string; leafB: string } => {
    const leaves: LeafDoc[] = [
      { _id: 'h:leaf-a', _rev: '1-a', data: a },
      { _id: 'h:leaf-b', _rev: '1-b', data: b },
    ];
    return { leaves, full: a + b, leafB: 'h:leaf-b' };
  };

  it('1. a missing-leaf pull never truncates: round aborts, cursor frozen, then converges', async () => {
    h = await bootSignedIn();
    const note = twoLeafNote('big.md', 'AAAA', 'BBBB');
    h.couch.injectRemoteChange('big.md', note.full, note.leaves);
    h.couch.dropLeaf(note.leafB); // the file doc references leaf-b but couch 404s it

    // The pull round hits the missing leaf, throws inside reassemble, and aborts BEFORE any write.
    const before = h.couch.lastSeq();
    const r1 = await h.plugin.syncNow();
    expect(r1.ok).toBe(false); // surfaced as an error, never a silent empty pull
    expect(h.vault.content('big.md')).toBeUndefined(); // no truncated body written
    expect(h.vault.paths()).toEqual([]);

    // The cursor was NOT advanced (still at seq 0), so the same change stays pending for a retry.
    void before;
    const key = `${h.plugin.activeSiteFqdn()}:work`;
    expect(h.plugin.settings.couchState[key]?.cursor ?? '0').toBe('0');

    // Restore the leaf; the next clean pull re-reads the frozen cursor's page and converges.
    h.couch.restoreLeaf(note.leafB);
    const r2 = await h.plugin.syncNow();
    expect(r2.ok).toBe(true);
    expect(h.vault.content('big.md')).toBe('AAAABBBB'); // full note, no truncation
  });

  it('2. delete -> tombstone (DELETE ?rev), and a pull-applied delete does not resurface locally', async () => {
    h = await bootSignedIn({ files: { 'note.md': 'body' } });
    await h.plugin.syncNow();
    expect(h.couch.fileDoc('note.md')).toBeDefined();

    // Local delete tombstones the file doc via a rev-scoped DELETE (the wire shape that matters).
    h.router.reset();
    del(h, 'note.md');
    await settle(() => h.couch.fileDoc('note.md') === undefined);
    const delCall = h.router.calls.find((c) => c.method === 'DELETE');
    expect(delCall).toBeDefined();
    expect(delCall?.url).toMatch(/note\.md\?rev=/); // DELETE ?rev=<current rev>, not a blind delete
    expect(h.couch.fileDoc('note.md')).toBeUndefined();

    // A remote delete of a DIFFERENT file pulls in and removes it locally; it does NOT then get
    // re-pushed as a phantom local deletion (the pull dropRev keeps it out of reconcileDeletions).
    await seedRemote(h, 'remote.md', 'remote note');
    await h.plugin.syncNow();
    expect(h.vault.content('remote.md')).toBe('remote note');
    h.couch.deleteRemote('remote.md');
    h.router.reset();
    const r = await h.plugin.syncNow();
    expect(r.ok).toBe(true);
    expect(h.vault.content('remote.md')).toBeUndefined(); // pull applied the remote delete
    // No phantom: the pull-applied delete never bounces back out as an extra DELETE for remote.md.
    const phantom = h.router.calls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('remote.md')
    );
    expect(phantom).toEqual([]);
  });

  it('3. stale delete abandoned when content moved on: edit wins, next pull restores the newer doc', async () => {
    h = await bootSignedIn({ files: { 'doc.md': 'v1' } });
    await h.plugin.syncNow(); // pushes doc.md@v1, rev-cache = v1's content rev

    // Another device advances the doc to v2 on couch (a newer edit than the one we knew).
    await seedRemote(h, 'doc.md', 'v2-from-other-device');

    // We delete doc.md locally. tombstone sees couch content-rev != our known rev -> abandons the
    // delete (edit-wins-over-stale-delete), never force-deleting the fresher remote version.
    del(h, 'doc.md'); // vault removal is synchronous; the tombstone attempt is async
    await drain(); // let the abandon-on-conflict path run to completion
    expect(h.couch.fileDoc('doc.md')).toBeDefined(); // the newer remote doc survived our stale delete

    // The next pull restores the newer doc into the vault (the edit won).
    const r = await h.plugin.syncNow();
    expect(r.ok).toBe(true);
    expect(h.vault.content('doc.md')).toBe('v2-from-other-device');
  });
});
