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

describe('fix 1 - a missing leaf never truncates the note', () => {
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

describe('fix 2 - resumable, paged pull cursor', () => {
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

describe('fix 3 - unchanged pushAll performs zero HTTP', () => {
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

describe('fix 4 - a failed live push is queued and retried on the next tick', () => {
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
