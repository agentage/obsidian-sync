/**
 * Sync-engine integration tests.
 *
 * Uses `pouchdb` (Node) with `pouchdb-adapter-memory` so we exercise the real
 * replication code on in-memory databases — no Obsidian, no CouchDB container,
 * no IndexedDB. Catches auth/headers/conflict/delete regressions in CI in
 * milliseconds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PouchDB from 'pouchdb';
import memoryAdapter from 'pouchdb-adapter-memory';
import {
  getAllLocalDocs,
  removeNote,
  resolveConflictedDoc,
  upsertNote,
  type MemoryDoc,
} from './pouch';

PouchDB.plugin(memoryAdapter);

function memDb(name: string): PouchDB.Database<MemoryDoc> {
  return new PouchDB<MemoryDoc>(name, { adapter: 'memory' });
}

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('upsertNote', () => {
  let db: PouchDB.Database<MemoryDoc>;
  beforeEach(() => {
    db = memDb(`test-upsert-${uniq()}`);
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('creates a new doc when none exists (rev 1)', async () => {
    const r = await upsertNote(db, 'notes/a.md', 'hello', 12345);
    expect(r.id).toBe('notes/a.md');
    expect(r.rev.startsWith('1-')).toBe(true);
    const doc = await db.get('notes/a.md');
    expect(doc.content).toBe('hello');
    expect(doc.mtime).toBe(12345);
  });

  it('updates an existing doc to the next revision (rev 2)', async () => {
    const first = await upsertNote(db, 'a.md', 'v1', 1);
    expect(first.rev.startsWith('1-')).toBe(true);
    const second = await upsertNote(db, 'a.md', 'v2', 2);
    expect(second.rev.startsWith('2-')).toBe(true);
    const doc = await db.get('a.md');
    expect(doc.content).toBe('v2');
    expect(doc.mtime).toBe(2);
  });

  it('keeps the vault path verbatim as _id (slashes + spaces intact)', async () => {
    await upsertNote(db, 'notes/sub/My Note.md', 'x', 0);
    const doc = await db.get('notes/sub/My Note.md');
    expect(doc._id).toBe('notes/sub/My Note.md');
  });
});

describe('PouchDB.sync (engine the plugin rides on)', () => {
  let local: PouchDB.Database<MemoryDoc>;
  let remote: PouchDB.Database<MemoryDoc>;
  beforeEach(() => {
    local = memDb(`test-local-${uniq()}`);
    remote = memDb(`test-remote-${uniq()}`);
  });
  afterEach(async () => {
    await local.destroy();
    await remote.destroy();
  });

  it('replicates local -> remote', async () => {
    await upsertNote(local, 'a.md', 'from local', 1);
    await PouchDB.sync(local, remote);
    const r = await remote.get('a.md');
    expect(r.content).toBe('from local');
  });

  it('replicates remote -> local', async () => {
    await upsertNote(remote, 'b.md', 'from remote', 2);
    await PouchDB.sync(local, remote);
    const l = await local.get('b.md');
    expect(l.content).toBe('from remote');
  });

  it('propagates a delete (tombstone) both ways', async () => {
    await upsertNote(local, 'c.md', 'will be deleted', 3);
    await PouchDB.sync(local, remote);
    const doc = await local.get('c.md');
    await local.remove(doc._id, doc._rev as string);
    await PouchDB.sync(local, remote);
    await expect(remote.get('c.md')).rejects.toMatchObject({ status: 404 });
  });

  it('converges on a single winning rev when both sides edit concurrently (loser kept as conflict)', async () => {
    await upsertNote(local, 'd.md', 'base', 1);
    await PouchDB.sync(local, remote);
    // Diverge without syncing.
    await upsertNote(local, 'd.md', 'local edit', 2);
    await upsertNote(remote, 'd.md', 'remote edit', 3);
    await PouchDB.sync(local, remote);

    const l = await local.get('d.md');
    const r = await remote.get('d.md');
    expect(l._rev).toBe(r._rev); // both sides converge on the same winning rev
    expect(l.content).toBe(r.content);

    // The loser branch is preserved internally for later resolution.
    const withConflicts = (await local.get('d.md', {
      conflicts: true,
    })) as PouchDB.Core.Document<MemoryDoc> & { _conflicts?: string[] };
    expect(withConflicts._conflicts?.length).toBe(1);
  });
});

describe('getAllLocalDocs', () => {
  let db: PouchDB.Database<MemoryDoc>;
  beforeEach(() => {
    db = memDb(`test-alldocs-${uniq()}`);
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('returns an empty map for an empty database', async () => {
    expect((await getAllLocalDocs(db)).size).toBe(0);
  });

  it('maps every doc by _id with content + mtime intact', async () => {
    await upsertNote(db, 'a.md', 'A', 1);
    await upsertNote(db, 'sub/b.md', 'B', 2);
    const map = await getAllLocalDocs(db);
    expect(map.size).toBe(2);
    expect(map.get('a.md')?.content).toBe('A');
    expect(map.get('sub/b.md')?.mtime).toBe(2);
  });

  it('omits tombstoned docs', async () => {
    await upsertNote(db, 'gone.md', 'x', 1);
    await removeNote(db, 'gone.md');
    expect((await getAllLocalDocs(db)).has('gone.md')).toBe(false);
  });
});

describe('removeNote', () => {
  let db: PouchDB.Database<MemoryDoc>;
  beforeEach(() => {
    db = memDb(`test-remove-${uniq()}`);
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('removes an existing doc and returns a tombstone revision', async () => {
    await upsertNote(db, 'a.md', 'content', 1);
    const r = await removeNote(db, 'a.md');
    expect(r).not.toBeNull();
    expect(r?.rev.startsWith('2-')).toBe(true);
    await expect(db.get('a.md')).rejects.toMatchObject({ status: 404 });
  });

  it('returns null (no-op) when the doc does not exist', async () => {
    const r = await removeNote(db, 'never-existed.md');
    expect(r).toBeNull();
  });
});

describe('rename via remove + upsert (two-way sync semantics)', () => {
  let local: PouchDB.Database<MemoryDoc>;
  let remote: PouchDB.Database<MemoryDoc>;
  beforeEach(() => {
    local = memDb(`test-rename-local-${uniq()}`);
    remote = memDb(`test-rename-remote-${uniq()}`);
  });
  afterEach(async () => {
    await local.destroy();
    await remote.destroy();
  });

  it('replicates a rename as a delete of old _id + put at new _id', async () => {
    await upsertNote(local, 'old.md', 'body', 1);
    await PouchDB.sync(local, remote);
    // Local rename: remove old, upsert new (same content).
    await removeNote(local, 'old.md');
    await upsertNote(local, 'new.md', 'body', 2);
    await PouchDB.sync(local, remote);

    await expect(remote.get('old.md')).rejects.toMatchObject({ status: 404 });
    const renamed = await remote.get('new.md');
    expect(renamed.content).toBe('body');
  });
});

describe('resolveConflictedDoc', () => {
  let local: PouchDB.Database<MemoryDoc>;
  beforeEach(() => {
    local = memDb(`test-conflict-${uniq()}`);
  });
  afterEach(async () => {
    await local.destroy();
  });

  /** Inject a competing generation-1 root — the shape a second client (or the
   * E2E's `injectConflict`) produces. The winner is whichever rev sorts higher,
   * which is independent of which body arrived last in the change feed. */
  async function injectSiblingConflict(loserContent: string, siblingContent: string) {
    await local.put({ _id: 'd.md', content: loserContent, mtime: 1 });
    await local.bulkDocs(
      [{ _id: 'd.md', _rev: '1-ffffffffffffffffffffffffffffffff', content: siblingContent }],
      { new_edits: false }
    );
  }

  it('returns the WINNER body + the losing branch, regardless of arrival order', async () => {
    // The fixed all-f rev always wins, so the first-written body is the loser —
    // exactly the case the old change-feed-body approach got wrong.
    await injectSiblingConflict('LOSES', 'WINS');
    const res = await resolveConflictedDoc(local, 'd.md');
    expect(res.deleted).toBe(false);
    expect(res.content).toBe('WINS');
    expect(res.losers.map((l) => l.content)).toEqual(['LOSES']);
  });

  it('clears the conflict after resolving', async () => {
    await injectSiblingConflict('LOSES', 'WINS');
    await resolveConflictedDoc(local, 'd.md');
    const resolved = (await local.get('d.md', { conflicts: true })) as MemoryDoc & {
      _conflicts?: string[];
    };
    expect(resolved._conflicts ?? []).toHaveLength(0);
  });

  it('reports an unconflicted doc as its own content with no losers', async () => {
    await upsertNote(local, 'clean.md', 'only me', 1);
    expect(await resolveConflictedDoc(local, 'clean.md')).toEqual({
      deleted: false,
      content: 'only me',
      losers: [],
    });
  });

  it('reports a missing/deleted doc as deleted', async () => {
    expect(await resolveConflictedDoc(local, 'ghost.md')).toEqual({
      deleted: true,
      content: '',
      losers: [],
    });
  });
});
