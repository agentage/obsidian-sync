import { describe, it, expect, vi } from 'vitest';
import { CouchTokenClient, parseCouchToken, type CouchTokenPost } from './couch-token';

const ok = (jwt: string, expSec = 3600): { status: number; json: unknown } => ({
  status: 200,
  json: { success: true, data: { jwt, db: 'mem_abc', sub: 'u/work', expSec } },
});

describe('parseCouchToken', () => {
  it('reads the { data } envelope and defaults expSec', () => {
    expect(parseCouchToken({ data: { jwt: 'j', db: 'd', sub: 's', expSec: 60 } })).toEqual({
      jwt: 'j',
      db: 'd',
      sub: 's',
      expSec: 60,
    });
    expect(parseCouchToken({ data: { jwt: 'j' } }).expSec).toBe(3600);
  });

  it('throws on a missing data object or jwt', () => {
    expect(() => parseCouchToken(null)).toThrow('missing data');
    expect(() => parseCouchToken({})).toThrow('missing data');
    expect(() => parseCouchToken({ data: {} })).toThrow('missing jwt');
  });
});

describe('CouchTokenClient - mint + cache + refresh', () => {
  const make = (
    post: CouchTokenPost,
    bearer: string | null = 'oauth-bearer',
    now: () => number = () => 0
  ): CouchTokenClient =>
    new CouchTokenClient(
      'https://auth.x/account/couch-token',
      'work',
      post,
      async () => bearer,
      now
    );

  it('mints once and serves the cache within the skew window', async () => {
    const post = vi.fn<CouchTokenPost>(async () => ok('jwt-1'));
    const c = make(post);
    expect(await c.token()).toBe('jwt-1');
    expect(await c.token()).toBe('jwt-1');
    expect(post).toHaveBeenCalledTimes(1);
    // The mint body carries { memory } and the OAuth bearer, never a signed credential.
    expect(post).toHaveBeenCalledWith(
      'https://auth.x/account/couch-token',
      JSON.stringify({ memory: 'work' }),
      'oauth-bearer'
    );
  });

  it('re-mints ~60s before expiry (skew) and again after invalidate()', async () => {
    let now = 0;
    let n = 0;
    const post = vi.fn<CouchTokenPost>(async () => ok(`jwt-${++n}`, 100)); // exp = now + 100s
    const c = make(post, 'oauth-bearer', () => now);
    expect(await c.token()).toBe('jwt-1');
    now = 39_000; // still >60s before the 100s expiry -> cache
    expect(await c.token()).toBe('jwt-1');
    now = 41_000; // within 60s of expiry -> re-mint
    expect(await c.token()).toBe('jwt-2');
    c.invalidate(); // e.g. a 401 from CouchDB
    expect(await c.token()).toBe('jwt-3');
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('throws a clear error on a 401 (the known server OAuth-bearer gap)', async () => {
    const post = vi.fn<CouchTokenPost>(async () => ({ status: 401, json: null }));
    await expect(make(post).token()).rejects.toThrow('unauthorized');
  });

  it('throws on other non-2xx and when not signed in', async () => {
    await expect(make(async () => ({ status: 503, json: null })).token()).rejects.toThrow(
      'HTTP 503'
    );
    await expect(make(async () => ok('j'), null).token()).rejects.toThrow('not signed in');
  });
});
