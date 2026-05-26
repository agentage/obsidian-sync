import { describe, expect, it } from 'vitest';
import { pingServer } from './connection';

describe('pingServer', () => {
  it('returns ok when the server responds 2xx', async () => {
    const r = await pingServer('https://example.com', async () => ({ status: 200 }));
    expect(r).toEqual({ ok: true, status: 200 });
  });

  it('strips trailing slashes before appending /_up', async () => {
    let calledWith = '';
    await pingServer('https://example.com///', async (u) => {
      calledWith = u;
      return { status: 200 };
    });
    expect(calledWith).toBe('https://example.com/_up');
  });

  it('returns not-ok with status when the server responds non-2xx', async () => {
    const r = await pingServer('https://example.com', async () => ({ status: 503 }));
    expect(r).toEqual({ ok: false, status: 503 });
  });

  it('returns not-ok with error message when fetch throws', async () => {
    const r = await pingServer('https://example.com', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});
