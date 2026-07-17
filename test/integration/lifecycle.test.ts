import { describe, it, expect, afterEach, vi } from 'vitest';
import { obsidianMockFactory } from '../fakes/obsidian';
vi.mock('obsidian', () => obsidianMockFactory());

import {
  bootReady,
  bootSignedIn,
  signIn,
  edit,
  settle,
  tick,
  couchActive,
  syncStateOf,
  MEMORY,
  type Handles,
} from './_helpers';

// Account lifecycle: a memory the server has not put on the couch channel, sign-out teardown, a
// memory switch that must repoint to a new db, and the connect flow. These guard the "never a
// silent no-op, never the wrong db" invariants.

describe('account lifecycle', () => {
  let h: Handles;
  afterEach(async () => h.teardown());

  it('10. a memory not on the couch channel routes to git and never touches couch', async () => {
    h = await bootSignedIn();
    // Dual-channel: a memory the resolution does NOT advertise on couch syncs via git. The
    // fake serves no git smart-HTTP, so the git sync itself fails - what matters here is the
    // couch side stays untouched and inert (no silent cross-channel write).
    await h.plugin.selectVault('not-migrated');
    const r = await h.plugin.syncNow();

    expect(r.ok).toBe(false); // the git path surfaced its own error (no git server in the fake)
    expect(r.message).not.toMatch(/not on the new sync channel/i); // couch-only error is gone
    expect(couchActive(h)).toBe(false); // the git route tears down any live couch controller
    expect(h.couch.filePaths()).toEqual([]); // and crucially: nothing was written to couch
  });

  it('11. sign-out tears the controller down; a later tick no-ops (no couch traffic)', async () => {
    h = await bootSignedIn();
    await h.plugin.syncNow();
    expect(couchActive(h)).toBe(true);

    await h.plugin.disconnect();
    expect(h.plugin.isSignedIn()).toBe(false);
    expect(couchActive(h)).toBe(false); // controller cleared on sign-out

    h.router.reset();
    await tick(h); // the 2s interval keeps firing after sign-out - it must be inert
    expect(h.router.calls).toEqual([]); // zero couch traffic from a torn-down channel
  });

  it('12. a memory switch repoints the controller to a new db; the old db is not reused', async () => {
    h = await bootSignedIn({ extraCouch: [{ memory: 'work2', db: 'mem_work2' }] });
    await h.plugin.syncNow(); // build the live controller for the primary memory 'work'

    // Sync memory 'work' (db mem_work): an edit lands in the primary store.
    edit(h, 'a.md', 'in work');
    await settle(() => h.couch.fileDoc('a.md') !== undefined);
    await h.plugin.syncNow();
    expect(h.couch.filePaths()).toContain('a.md');

    // Switch to 'work2' (db mem_work2), then sync so the controller rebuilds against the new db.
    await h.plugin.selectVault('work2');
    await h.plugin.syncNow(); // repoints the live controller to mem_work2
    edit(h, 'b.md', 'in work2');
    await settle(() => h.extraCouch['work2'].fileDoc('b.md') !== undefined);
    await h.plugin.syncNow();

    // b.md landed in the NEW db only; the OLD db never saw it (no cross-db leakage).
    expect(h.extraCouch['work2'].filePaths()).toContain('b.md');
    expect(h.couch.filePaths()).not.toContain('b.md');
  });

  it('13. connect flow: discovery -> DCR -> authorize -> token exchange, dot goes green', async () => {
    h = await bootReady();
    expect(h.plugin.isSignedIn()).toBe(false); // gray dot at boot

    await signIn(h); // discovery + register + authorize + code->token, all through the router
    expect(h.plugin.isSignedIn()).toBe(true);

    // The connect flow touched each OAuth step exactly as the AS contract expects.
    const hit = (frag: string): boolean => h.router.calls.some((c) => c.url.includes(frag));
    expect(hit('/.well-known/oauth-authorization-server')).toBe(true); // discovery
    expect(hit('/register')).toBe(true); // DCR
    expect(hit('/token')).toBe(true); // code exchange

    // With a memory selected the dot is ready (green): signed in, no error, memory chosen.
    await h.plugin.selectVault(MEMORY);
    expect(syncStateOf(h)).not.toBe('error');
    expect(h.plugin.currentVault()).toBe(MEMORY);
  });
});
