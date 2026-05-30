/**
 * Inbound apply + seed tests. Real in-memory PouchDB (pouchdb-adapter-memory)
 * for the local replica + a fake VaultGateway — no Obsidian, no CouchDB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PouchDB from 'pouchdb';
import memoryAdapter from 'pouchdb-adapter-memory';
import { applyPulledDoc, seedLocalReplica } from './inbound';
import { conflictSidecarPath } from './conflict';
import { createEchoSuppress } from './echo-suppress';
import type { VaultGateway } from './apply-doc';
import type { LocalDb, MemoryDoc } from './pouch';

PouchDB.plugin(memoryAdapter);

interface FakeFile {
  path: string;
  content: string;
}

function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, FakeFile>(
    Object.entries(initial).map(([path, content]) => [path, { path, content }])
  );
  const ops: string[] = [];
  const gateway: VaultGateway = {
    normalizePath(path) {
      return path
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/+|\/+$/g, '');
    },
    getFile(path) {
      return files.get(path) ?? null;
    },
    async read(file) {
      return (file as FakeFile).content;
    },
    async modify(file, content) {
      (file as FakeFile).content = content;
      ops.push(`modify:${(file as FakeFile).path}`);
    },
    async trash(file) {
      files.delete((file as FakeFile).path);
      ops.push(`trash:${(file as FakeFile).path}`);
    },
    async create(path, content) {
      files.set(path, { path, content });
      ops.push(`create:${path}`);
    },
    async ensureParentFolder(path) {
      if (path.includes('/')) ops.push(`folder:${path.slice(0, path.lastIndexOf('/'))}`);
    },
    async listNotes() {
      return [...files.values()].map((f) => ({ path: f.path, content: f.content, mtime: 1 }));
    },
  };
  return { gateway, files, ops };
}

describe('inbound', () => {
  let db: LocalDb;

  beforeEach(() => {
    db = new PouchDB<MemoryDoc>('inbound-test', { adapter: 'memory' }) as unknown as LocalDb;
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('applyPulledDoc', () => {
    it('creates the vault note from the winning revision', async () => {
      await db.put({ _id: 'a.md', content: 'hello', mtime: 1 });
      const { gateway, files } = fakeVault();
      await applyPulledDoc(db, gateway, createEchoSuppress(), 'a.md');
      expect(files.get('a.md')?.content).toBe('hello');
    });

    it('trashes the vault note when the winning revision is a tombstone', async () => {
      const put = await db.put({ _id: 'gone.md', content: 'x', mtime: 1 });
      await db.remove('gone.md', put.rev);
      const { gateway, files } = fakeVault({ 'gone.md': 'x' });
      await applyPulledDoc(db, gateway, createEchoSuppress(), 'gone.md');
      expect(files.has('gone.md')).toBe(false);
    });

    it('preserves a conflict loser as a sidecar note', async () => {
      // Force two conflicting leaf revisions for the same id.
      await db.bulkDocs([{ _id: 'c.md', _rev: '1-aaaa', content: 'A' }], { new_edits: false });
      await db.bulkDocs([{ _id: 'c.md', _rev: '1-bbbb', content: 'B' }], { new_edits: false });
      const { gateway, files } = fakeVault();
      await applyPulledDoc(db, gateway, createEchoSuppress(), 'c.md');
      // Winner (1-bbbb) lands at the real path; loser (1-aaaa) is kept as a sidecar.
      expect(files.get('c.md')?.content).toBe('B');
      const sidecar = conflictSidecarPath('c.md', '1-aaaa');
      expect(files.get(sidecar)?.content).toBe('A');
    });

    it('does not overwrite a sidecar that already exists', async () => {
      await db.bulkDocs([{ _id: 'c.md', _rev: '1-aaaa', content: 'A' }], { new_edits: false });
      await db.bulkDocs([{ _id: 'c.md', _rev: '1-bbbb', content: 'B' }], { new_edits: false });
      const sidecar = conflictSidecarPath('c.md', '1-aaaa');
      const { gateway, files } = fakeVault({ [sidecar]: 'kept' });
      await applyPulledDoc(db, gateway, createEchoSuppress(), 'c.md');
      expect(files.get(sidecar)?.content).toBe('kept');
    });
  });

  describe('seedLocalReplica', () => {
    it('seeds every pre-existing note into an empty replica', async () => {
      const { gateway } = fakeVault({ 'a.md': 'one', 'b.md': 'two' });
      const seeded = await seedLocalReplica(db, gateway);
      expect(seeded).toBe(2);
      const a = await db.get('a.md');
      expect(a.content).toBe('one');
    });

    it('is idempotent — re-running seeds nothing new', async () => {
      const { gateway } = fakeVault({ 'a.md': 'one' });
      await seedLocalReplica(db, gateway);
      expect(await seedLocalReplica(db, gateway)).toBe(0);
    });
  });
});
