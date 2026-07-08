import { describe, it, expect, vi } from 'vitest';
import { CouchState } from './couch-state';
import type { CouchMemoryState } from '../settings';

// A data.json-backed store: load reads the last saved blob, save records it (and counts writes).
const backing = () => {
  let stored: CouchMemoryState | undefined;
  const save = vi.fn(async (s: CouchMemoryState) => {
    stored = s;
  });
  return { load: () => stored, save, get: (): CouchMemoryState | undefined => stored };
};

describe('CouchState - pull cursor', () => {
  it('defaults to seq 0 and persists an advance', async () => {
    const b = backing();
    const s = new CouchState(b.load, b.save);
    expect(s.getCursor()).toBe('0');
    await s.setCursor('5');
    expect(s.getCursor()).toBe('5');
    expect(b.get()?.cursor).toBe('5');
  });

  it('survives a simulated reload (a fresh instance rehydrates the saved cursor)', async () => {
    const b = backing();
    await new CouchState(b.load, b.save).setCursor('42');
    const reloaded = new CouchState(b.load, b.save);
    expect(reloaded.getCursor()).toBe('42');
  });

  it('does not write when the cursor is unchanged', async () => {
    const b = backing();
    const s = new CouchState(b.load, b.save);
    await s.setCursor('0'); // same as default
    expect(b.save).not.toHaveBeenCalled();
  });
});

describe('CouchState - push-rev cache', () => {
  it('sets, reads, and drops a rev, persisting each real change', async () => {
    const b = backing();
    const s = new CouchState(b.load, b.save);
    expect(s.revFor('a.md')).toBeUndefined();
    await s.setRev('a.md', 'r1');
    expect(s.revFor('a.md')).toBe('r1');
    expect(b.get()?.revs).toEqual({ 'a.md': 'r1' });
    await s.setRev('a.md', 'r1'); // no-op
    expect(b.save).toHaveBeenCalledTimes(1);
    await s.dropRev('a.md');
    expect(s.revFor('a.md')).toBeUndefined();
    await s.dropRev('a.md'); // absent -> no write
    expect(b.save).toHaveBeenCalledTimes(2);
  });

  it('rehydrates the rev map on reload', async () => {
    const b = backing();
    await new CouchState(b.load, b.save).setRev('a.md', 'r9');
    expect(new CouchState(b.load, b.save).revFor('a.md')).toBe('r9');
  });

  it('knownPaths lists every path with a cached rev (the local-deletion oracle)', async () => {
    const b = backing();
    const s = new CouchState(b.load, b.save);
    expect(s.knownPaths()).toEqual([]);
    await s.setRev('a.md', 'r1');
    await s.setRev('b.md', 'r2');
    expect(s.knownPaths().sort()).toEqual(['a.md', 'b.md']);
    await s.dropRev('a.md');
    expect(s.knownPaths()).toEqual(['b.md']);
  });
});

describe('CouchState - pending pushes', () => {
  it('enqueues without duplicates and dequeues, persisting real changes only', async () => {
    const b = backing();
    const s = new CouchState(b.load, b.save);
    await s.enqueue('a.md');
    await s.enqueue('a.md'); // dup -> no write
    await s.enqueue('b.md');
    expect(s.pendingPaths().sort()).toEqual(['a.md', 'b.md']);
    expect(b.save).toHaveBeenCalledTimes(2);
    await s.dequeue('a.md');
    await s.dequeue('a.md'); // absent -> no write
    expect(s.pendingPaths()).toEqual(['b.md']);
    expect(b.save).toHaveBeenCalledTimes(3);
    expect(b.get()?.pending).toEqual(['b.md']);
  });

  it('rehydrates pending on reload', async () => {
    const b = backing();
    await new CouchState(b.load, b.save).enqueue('x.md');
    expect(new CouchState(b.load, b.save).pendingPaths()).toEqual(['x.md']);
  });
});

describe('CouchState - pending deletes', () => {
  it('enqueues without duplicates and dequeues, persisting real changes only', async () => {
    const b = backing();
    const s = new CouchState(b.load, b.save);
    await s.enqueueDelete('a.md');
    await s.enqueueDelete('a.md'); // dup -> no write
    await s.enqueueDelete('b.md');
    expect(s.pendingDeletePaths().sort()).toEqual(['a.md', 'b.md']);
    expect(b.save).toHaveBeenCalledTimes(2);
    await s.dequeueDelete('a.md');
    await s.dequeueDelete('a.md'); // absent -> no write
    expect(s.pendingDeletePaths()).toEqual(['b.md']);
    expect(b.save).toHaveBeenCalledTimes(3);
    expect(b.get()?.pendingDeletes).toEqual(['b.md']);
  });

  it('rehydrates pending deletes on reload, independent of pending pushes', async () => {
    const b = backing();
    const s = new CouchState(b.load, b.save);
    await s.enqueue('push.md');
    await s.enqueueDelete('del.md');
    const reloaded = new CouchState(b.load, b.save);
    expect(reloaded.pendingPaths()).toEqual(['push.md']);
    expect(reloaded.pendingDeletePaths()).toEqual(['del.md']);
  });

  it('loads an old-shape snapshot (no pendingDeletes field) as an empty set', () => {
    const stored: CouchMemoryState = { cursor: '3', revs: { 'a.md': 'r1' }, pending: ['b.md'] };
    const s = new CouchState(
      () => stored,
      async () => {}
    );
    expect(s.getCursor()).toBe('3');
    expect(s.revFor('a.md')).toBe('r1');
    expect(s.pendingPaths()).toEqual(['b.md']);
    expect(s.pendingDeletePaths()).toEqual([]); // absent field -> empty, no crash
  });
});
