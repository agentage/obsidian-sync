import { describe, expect, it } from 'vitest';
import { DB_NAME, ensureDatabase, pushNote, type FetchInit } from './sync';

const creds = { serverUrl: 'http://localhost:5984', username: 'admin', password: 'pw' };

describe('ensureDatabase', () => {
  it('is a no-op when the database already exists (HEAD 200)', async () => {
    const calls: string[] = [];
    await ensureDatabase(creds, async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return { status: 200, text: '' };
    });
    expect(calls).toEqual([`HEAD http://localhost:5984/${DB_NAME}`]);
  });

  it('creates the database when missing (HEAD 404 → PUT 201)', async () => {
    const calls: string[] = [];
    await ensureDatabase(creds, async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return { status: init?.method === 'HEAD' ? 404 : 201, text: '' };
    });
    expect(calls).toEqual([
      `HEAD http://localhost:5984/${DB_NAME}`,
      `PUT http://localhost:5984/${DB_NAME}`,
    ]);
  });

  it('treats PUT 412 (already exists by race) as success', async () => {
    let i = 0;
    await ensureDatabase(creds, async () => {
      i += 1;
      return { status: i === 1 ? 404 : 412, text: '' };
    });
  });

  it('throws on auth failure', async () => {
    await expect(ensureDatabase(creds, async () => ({ status: 401, text: '' }))).rejects.toThrow(
      /auth failed/
    );
  });
});

describe('pushNote', () => {
  it('creates a new doc when none exists (GET 404 → PUT 201, no _rev)', async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const r = await pushNote(creds, 'notes/foo.md', '# Hi', 1234, async (url, init?: FetchInit) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body });
      if (init?.method === 'GET') return { status: 404, text: '' };
      return {
        status: 201,
        text: JSON.stringify({ ok: true, id: 'notes/foo.md', rev: '1-abc' }),
      };
    });
    expect(r).toEqual({ id: 'notes/foo.md', rev: '1-abc' });
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('GET');
    expect(calls[1].method).toBe('PUT');
    const body = JSON.parse(calls[1].body ?? '{}') as Record<string, unknown>;
    expect(body._id).toBe('notes/foo.md');
    expect(body.content).toBe('# Hi');
    expect(body.mtime).toBe(1234);
    expect(body._rev).toBeUndefined();
  });

  it('updates with _rev when the doc already exists', async () => {
    let putBody = '';
    const r = await pushNote(creds, 'a.md', 'x', 1, async (_url, init?: FetchInit) => {
      if (init?.method === 'GET') {
        return { status: 200, text: JSON.stringify({ _id: 'a.md', _rev: '1-old' }) };
      }
      putBody = init?.body ?? '';
      return { status: 201, text: JSON.stringify({ ok: true, id: 'a.md', rev: '2-new' }) };
    });
    expect(r.rev).toBe('2-new');
    expect((JSON.parse(putBody) as { _rev: string })._rev).toBe('1-old');
  });

  it('url-encodes the doc id (handles slashes and spaces in vault paths)', async () => {
    let putUrl = '';
    await pushNote(creds, 'notes/My Note.md', '', 0, async (url, init?: FetchInit) => {
      if (init?.method === 'PUT') putUrl = url;
      return {
        status: init?.method === 'GET' ? 404 : 201,
        text: '{"ok":true,"id":"x","rev":"1-r"}',
      };
    });
    expect(putUrl).toBe(`http://localhost:5984/${DB_NAME}/notes%2FMy%20Note.md`);
  });
});
