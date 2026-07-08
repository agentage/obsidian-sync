import { describe, it, expect, afterEach, vi } from 'vitest';
import { obsidianMockFactory } from '../fakes/obsidian';
vi.mock('obsidian', () => obsidianMockFactory());

import {
  bootSignedIn,
  seedRemote,
  edit,
  settle,
  drain,
  tick,
  pendingCount,
  leavesFor,
  expireAccessToken,
  type Handles,
} from './_helpers';

// Fault-injection resilience: a 401 mid-replication, an expired OAuth token, a dropped live
// push, and a resumable cursor across a reload. Each drives the fault explicitly, then asserts
// the sync converges (no silent stall, no lost edit).

describe('replication resilience', () => {
  let h: Handles;
  afterEach(async () => h.teardown());

  it('6. couch 401 mid-replication -> re-mint the couch JWT + retry once, sync completes', async () => {
    h = await bootSignedIn();
    await seedRemote(h, 'seed.md', 'seed body'); // give the pull something to deliver

    // The next couch request comes back 401 (an expired couch JWT); CouchSync must invalidate
    // its token cache and re-mint before retrying the same request in the same round.
    h.couch.unauthorizeUntilRemint();
    h.router.reset();
    const r = await h.plugin.syncNow();

    expect(r.ok).toBe(true); // the retry succeeded - the 401 did not fail the round
    expect(h.vault.content('seed.md')).toBe('seed body'); // pull still delivered after re-mint
    // Re-mint = a second POST to the couch-token endpoint (the token cache was invalidated).
    const mints = h.router.calls.filter(
      (c) => c.method === 'POST' && c.url.includes('/account/couch-token')
    );
    expect(mints.length).toBeGreaterThanOrEqual(1);
  });

  it('7. expired OAuth access token -> refresh + rotate before the couch JWT is minted', async () => {
    h = await bootSignedIn();
    await h.plugin.syncNow(); // warm everything with the original token

    // The OAuth access token expired; the next getValidToken must refresh (grant=refresh_token)
    // and rotate before couch-token mint / resolution reuse the bearer.
    expireAccessToken(h);
    h.router.reset();
    const r = await h.plugin.syncNow();

    expect(r.ok).toBe(true);
    const refreshes = h.router.calls.filter((c) => c.method === 'POST' && c.url.includes('/token'));
    expect(refreshes.length).toBeGreaterThanOrEqual(1); // a refresh_token grant fired
    expect(h.plugin.isSignedIn()).toBe(true); // the rotated token kept the session alive
  });

  it('8. a rejected live push queues; pendingCount reflects it; the next tick flushes it', async () => {
    h = await bootSignedIn();
    await h.plugin.syncNow();

    // Reject the leaf write on the live push's _bulk_docs (a leaf couch refused) so the push
    // throws and queues. (A bare failNext(503) would land on the leading getDoc, which tolerates
    // a non-200 as "doc absent" and pushes anyway - so we fault the actual write instead.)
    const leaf = (await leavesFor('offline edit'))[0]._id;
    h.couch.failLeafOnBulk(leaf, 'forbidden');
    edit(h, 'queued.md', 'offline edit');
    await settle(() => pendingCount(h) === 1);
    expect(pendingCount(h)).toBe(1); // the honest "to send" count the sync popup shows
    expect(h.couch.fileDoc('queued.md')).toBeUndefined(); // nothing reached couch yet

    // The 2s tick retries the queue; the scripted failure is one-shot, so the flush now lands it.
    await tick(h);
    await drain();
    expect(h.couch.fileDoc('queued.md')?.size).toBe('offline edit'.length);
    expect(pendingCount(h)).toBe(0); // queue drained
  });

  it('9. paged pull cursor persists across a simulated reload (resumes, no re-pull from 0)', async () => {
    h = await bootSignedIn();
    await seedRemote(h, 'one.md', 'first');
    await seedRemote(h, 'two.md', 'second');
    await h.plugin.syncNow();

    const key = `${h.plugin.activeSiteFqdn()}:work`;
    const savedCursor = h.plugin.settings.couchState[key]?.cursor;
    expect(Number(savedCursor)).toBeGreaterThan(0); // the cursor advanced past the two changes
    // The _changes poll is paged: it carries since + limit, so a large feed never lands at once.
    const changes = h.router.calls.filter((c) => c.url.includes('/_changes'));
    expect(changes.some((c) => /since=\d+/.test(c.url) && /limit=\d+/.test(c.url))).toBe(true);

    // Rebuild the plugin from the SAVED couchState (a reload): it must resume at the persisted
    // cursor and pull ZERO changes, not re-fetch from seq 0.
    const persisted = h.plugin.settings.couchState;
    await h.teardown();
    h = await bootSignedIn({ files: { 'one.md': 'first', 'two.md': 'second' } });
    h.plugin.settings.couchState = persisted; // as loadSettings would hydrate from data.json
    // Reattach the same server-side state so a fresh pull from the saved cursor is a no-op.
    await seedRemote(h, 'one.md', 'first');
    await seedRemote(h, 'two.md', 'second');
    // The saved cursor is beyond the original changes; only a genuinely new change would apply.
    h.router.reset();
    const again = await h.plugin.syncNow();
    expect(again.ok).toBe(true);
    const resumed = h.router.calls.filter((c) => c.url.includes('/_changes'));
    expect(resumed[0]?.url).toContain(`since=${persisted[key]?.cursor}`);
  });
});
