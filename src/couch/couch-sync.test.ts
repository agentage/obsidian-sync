import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requestUrl,
  TFile,
  type RequestUrlParam,
  type RequestUrlResponse,
  type Vault,
} from 'obsidian';
import { CouchSync, type CouchSyncConfig } from './couch-sync';
import { CouchState } from './couch-state';
import type { CouchMemoryState } from '../settings';

// Only the requestUrl/TFile coupling is mocked; the doc model + state are the real modules.
vi.mock('obsidian', () => ({ requestUrl: vi.fn(), TFile: class TFile {} }));
const mockRequestUrl = vi.mocked(requestUrl);

type Res = { status: number; json: unknown };
const res = (status: number, json: unknown): Res => ({ status, json });
type Handler = (url: string, method: string, body?: string) => Res;
let handler: Handler = () => res(404, {});

const mkFile = (path: string): TFile =>
  Object.assign(new TFile(), { path, extension: path.split('.').pop() ?? '' }) as unknown as TFile;

// A minimal in-memory Vault - only the surface CouchSync touches.
class FakeVault {
  private files = new Map<string, { file: TFile; content: string }>();
  modifyCalls = 0;
  createCalls = 0;
  deleteCalls = 0;
  constructor(init: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(init)) this.files.set(p, { file: mkFile(p), content: c });
  }
  getAbstractFileByPath(p: string): TFile | null {
    return this.files.get(p)?.file ?? null;
  }
  async read(f: TFile): Promise<string> {
    return this.files.get(f.path)?.content ?? '';
  }
  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].map((v) => v.file);
  }
  async modify(f: TFile, data: string): Promise<void> {
    this.modifyCalls++;
    this.files.set(f.path, { file: f, content: data });
  }
  async create(p: string, data: string): Promise<TFile> {
    this.createCalls++;
    const file = mkFile(p);
    this.files.set(p, { file, content: data });
    return file;
  }
  async createFolder(_p: string): Promise<void> {}
  async delete(f: TFile): Promise<void> {
    this.deleteCalls++;
    this.files.delete(f.path);
  }
  content(p: string): string | undefined {
    return this.files.get(p)?.content;
  }
}

const backing = () => {
  let stored: CouchMemoryState | undefined;
  return {
    load: () => stored,
    save: async (s: CouchMemoryState) => {
      stored = s;
    },
    get: (): CouchMemoryState | undefined => stored,
  };
};

const makeSync = (
  vault: FakeVault,
  state: CouchState,
  cfg: Partial<CouchSyncConfig> = {}
): CouchSync =>
  new CouchSync(
    vault as unknown as Vault,
    { endpoint: 'http://couch.test', db: 'mem_x', ...cfg },
    async () => 'jwt',
    vi.fn(),
    state
  );

const fileDoc = (path: string, rev: string) => ({
  _id: `f:${path}`,
  _rev: rev,
  type: 'file',
  path,
  size: 1,
  leaves: [],
});

const changesUrls = (): string[] =>
  mockRequestUrl.mock.calls
    .map((c) => (c[0] as RequestUrlParam).url)
    .filter((u) => u.includes('/_changes'));

beforeEach(() => {
  mockRequestUrl.mockReset();
  mockRequestUrl.mockImplementation(((o: RequestUrlParam) =>
    Promise.resolve(
      handler(
        o.url,
        o.method ?? 'GET',
        o.body as string | undefined
      ) as unknown as RequestUrlResponse
    )) as unknown as typeof requestUrl);
  // writeVault schedules a suppress-cleanup via window.setTimeout; no real timers in tests.
  vi.stubGlobal('window', { setTimeout: () => 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe('unchanged pushAll performs zero HTTP', () => {
  it('skips the network entirely on the second pushAll when nothing changed', async () => {
    const vault = new FakeVault({ 'notes/n.md': 'X' });
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    const couch = makeSync(vault, state);
    handler = (url, method) => {
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {}); // f: GET -> not on server yet
    };

    await couch.pushAll();
    expect(mockRequestUrl.mock.calls.length).toBeGreaterThan(0);

    mockRequestUrl.mockClear();
    await couch.pushAll();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});

describe('a failed live push is queued and retried on the next tick', () => {
  it('queues the path on a network error, then flushes it successfully on tick()', async () => {
    const vault = new FakeVault({ 'notes/n.md': 'X' });
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    const couch = makeSync(vault, state);

    handler = () => {
      throw new Error('network down');
    };
    await couch.pushFileLive('notes/n.md');
    expect(state.pendingPaths()).toEqual(['notes/n.md']);

    handler = (url, method) => {
      if (url.includes('/_changes')) return res(200, { results: [], last_seq: '0' });
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {});
    };
    await couch.tick();

    expect(state.pendingPaths()).toEqual([]);
    const puts = mockRequestUrl.mock.calls.filter(
      (c) => (c[0] as RequestUrlParam).method === 'PUT'
    );
    expect(puts.length).toBe(1);
  });
});

describe('a couch-rejected push is queued, not silently cached', () => {
  it('does not cache the rev on a non-2xx PUT, so the next tick retries it', async () => {
    const vault = new FakeVault({ 'notes/n.md': 'X' });
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    const couch = makeSync(vault, state);

    handler = (url, method) => {
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(500, {}); // couch rejects the file doc
      return res(404, {}); // f: GET -> not on server yet
    };
    await couch.pushFileLive('notes/n.md');
    expect(state.pendingPaths()).toEqual(['notes/n.md']);
    expect(state.revFor('notes/n.md')).toBeUndefined(); // NOT cached -> stays retryable

    handler = (url, method) => {
      if (url.includes('/_changes')) return res(200, { results: [], last_seq: '0' });
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {});
    };
    await couch.tick();
    expect(state.pendingPaths()).toEqual([]);
    expect(state.revFor('notes/n.md')).toBeDefined(); // cached only after couch accepted it
  });
});

describe('a per-leaf _bulk_docs error queues the push, no file doc PUT', () => {
  it('throws on a reported leaf error so the file doc (missing leaf) is not written, then retries', async () => {
    const vault = new FakeVault({ 'notes/n.md': 'X' });
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    const couch = makeSync(vault, state);

    handler = (url, method) => {
      // new_edits:false returns an entry ONLY for a leaf that failed: a genuine per-doc error.
      if (url.includes('_bulk_docs')) return res(200, [{ id: 'h:bad', error: 'forbidden' }]);
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {}); // f: GET -> not on server yet
    };
    await couch.pushFileLive('notes/n.md');
    expect(state.pendingPaths()).toEqual(['notes/n.md']); // queued, retryable
    expect(state.revFor('notes/n.md')).toBeUndefined(); // NOT cached
    const puts = mockRequestUrl.mock.calls.filter(
      (c) => (c[0] as RequestUrlParam).method === 'PUT'
    );
    expect(puts.length).toBe(0); // never PUT a file doc whose leaves may be missing

    handler = (url, method) => {
      if (url.includes('/_changes')) return res(200, { results: [], last_seq: '0' });
      if (url.includes('_bulk_docs')) return res(200, []); // all leaves accepted now
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {});
    };
    await couch.tick();
    expect(state.pendingPaths()).toEqual([]);
    expect(state.revFor('notes/n.md')).toBeDefined(); // cached only after the leaves landed
  });
});

describe('a rejected delete stays retryable', () => {
  it('queues the path on a non-2xx DELETE, then a later tick completes it', async () => {
    const vault = new FakeVault(); // file already gone locally
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    await state.setRev('n.md', 'r1'); // was previously pushed -> couch holds the doc
    const couch = makeSync(vault, state);

    handler = (url, method) => {
      if (url.includes('f%3A') && method === 'DELETE') return res(500, {}); // couch rejects it
      if (url.includes('f%3A')) return res(200, fileDoc('n.md', '3-abc'));
      return res(404, {});
    };
    await couch.removeFile('n.md');
    expect(state.pendingDeletePaths()).toEqual(['n.md']);
    expect(state.revFor('n.md')).toBe('r1'); // rev kept -> still known to exist on couch

    handler = (url, method) => {
      if (url.includes('/_changes')) return res(200, { results: [], last_seq: '0' });
      if (url.includes('f%3A') && method === 'DELETE') return res(200, { ok: true });
      if (url.includes('f%3A')) return res(200, fileDoc('n.md', '3-abc'));
      return res(404, {});
    };
    await couch.tick();
    expect(state.pendingDeletePaths()).toEqual([]);
    expect(state.revFor('n.md')).toBeUndefined(); // dropped only after couch accepted the delete
  });

  it('re-reads the fresh rev and retries the delete on a 409', async () => {
    const vault = new FakeVault();
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    const couch = makeSync(vault, state);

    let deleteAttempts = 0;
    handler = (url, method) => {
      if (url.includes('f%3A') && method === 'DELETE') {
        deleteAttempts++;
        return url.includes('rev=1-stale') ? res(409, {}) : res(200, { ok: true });
      }
      if (url.includes('f%3A'))
        return res(200, fileDoc('n.md', deleteAttempts === 0 ? '1-stale' : '2-fresh'));
      return res(404, {});
    };
    await couch.removeFile('n.md');
    expect(deleteAttempts).toBe(2); // stale rev rejected, fresh rev accepted
    expect(state.pendingDeletePaths()).toEqual([]);
  });
});

describe('a locally-absent path deletes without error', () => {
  it('treats a doc already absent on the server as an idempotent success', async () => {
    const vault = new FakeVault();
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    const couch = makeSync(vault, state);
    handler = () => res(404, {}); // nothing on the server
    await expect(couch.removeFile('gone.md')).resolves.toBeUndefined();
    expect(state.pendingDeletePaths()).toEqual([]); // not queued
  });
});

describe('resumable, paged pull cursor', () => {
  it('pages _changes with successive since= values and persists the cursor', async () => {
    const vault = new FakeVault();
    const b = backing();
    const state = new CouchState(b.load, b.save);
    const couch = makeSync(vault, state, { pageLimit: 2 });
    handler = (url) => {
      if (url.includes('/_changes') && url.includes('since=0'))
        return res(200, {
          results: [
            {
              id: 'f:a.md',
              doc: { _id: 'f:a.md', type: 'file', path: 'a.md', size: 3, leaves: ['h:a1'] },
            },
            {
              id: 'f:b.md',
              doc: { _id: 'f:b.md', type: 'file', path: 'b.md', size: 3, leaves: ['h:b1'] },
            },
          ],
          last_seq: '2',
        });
      if (url.includes('/_changes') && url.includes('since=2'))
        return res(200, { results: [], last_seq: '2' });
      if (url.includes('h%3Aa1')) return res(200, { data: 'AAA' });
      if (url.includes('h%3Ab1')) return res(200, { data: 'BBB' });
      return res(404, {});
    };

    await couch.pullOnce();

    const changes = changesUrls();
    expect(changes).toHaveLength(2);
    expect(changes[0]).toContain('since=0');
    expect(changes[1]).toContain('since=2');
    expect(changes[0]).toContain('limit=2');
    expect(vault.content('a.md')).toBe('AAA');
    expect(vault.content('b.md')).toBe('BBB');
    expect(state.getCursor()).toBe('2');
    expect(b.get()?.cursor).toBe('2'); // persisted -> survives a reload
  });
});

describe('a missing leaf never truncates the note', () => {
  it('aborts the pull, leaves the file untouched, and does not advance the cursor', async () => {
    const vault = new FakeVault({ 'notes/a.md': 'ORIGINAL' });
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    const couch = makeSync(vault, state);
    handler = (url) => {
      if (url.includes('/_changes'))
        return res(200, {
          results: [
            {
              id: 'f:notes/a.md',
              doc: {
                _id: 'f:notes/a.md',
                type: 'file',
                path: 'notes/a.md',
                size: 5,
                leaves: ['h:AAA', 'h:BBB'],
              },
            },
          ],
          last_seq: '3',
        });
      if (url.includes('h%3AAAA')) return res(200, { _id: 'h:AAA', _rev: '1-x', data: 'hello' });
      return res(404, {}); // h:BBB (and anything else) is missing
    };

    await expect(couch.pullOnce()).rejects.toThrow('missing leaf');
    expect(vault.modifyCalls).toBe(0);
    expect(vault.content('notes/a.md')).toBe('ORIGINAL');
    expect(state.getCursor()).toBe('0'); // cursor NOT advanced -> next tick retries
  });
});

describe('a non-2xx pull surfaces as a failing sync', () => {
  it('throws on a non-2xx _changes feed instead of silently succeeding', async () => {
    const vault = new FakeVault();
    const b = backing();
    const state = new CouchState(b.load, b.save);
    const couch = makeSync(vault, state);
    handler = (url) =>
      url.includes('/_changes') ? res(403, { error: 'forbidden' }) : res(404, {});
    await expect(couch.pullOnce()).rejects.toThrow('_changes 403');
    expect(state.getCursor()).toBe('0'); // cursor NOT advanced
  });

  it('tick logs a failing pull instead of throwing (fire-and-forget safe)', async () => {
    const vault = new FakeVault();
    const state = new CouchState(
      () => undefined,
      async () => {}
    );
    const couch = makeSync(vault, state);
    handler = (url) => (url.includes('/_changes') ? res(500, {}) : res(404, {}));
    await expect(couch.tick()).resolves.toBeUndefined();
  });
});
