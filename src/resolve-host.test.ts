import { describe, it, expect, vi } from 'vitest';
import { HostResolver, parseResolution, buildRepoUrl } from './resolve-host';

describe('resolve-host (R7 resolve + 1h cache)', () => {
  it('parses a well-formed resolution and defaults ttl/region/vaults', () => {
    expect(
      parseResolution({ git_endpoint: 'https://sync-eu.x/u', region: 'eu', vaults: ['a'], ttl: 60 })
    ).toEqual({
      gitEndpoint: 'https://sync-eu.x/u',
      region: 'eu',
      vaults: ['a'],
      ttl: 60,
    });
    expect(parseResolution({ git_endpoint: 'https://sync-eu.x/u' })).toMatchObject({
      region: 'default',
      vaults: [],
      ttl: 3600,
    });
  });

  it('rejects a malformed resolution', () => {
    expect(() => parseResolution({})).toThrow();
    expect(() => parseResolution(null)).toThrow();
  });

  it('builds the per-vault repo URL (no token)', () => {
    expect(buildRepoUrl('https://sync-eu.x/u/', 'personal')).toBe(
      'https://sync-eu.x/u/personal.git'
    );
  });

  it('caches within ttl and re-fetches after it expires', async () => {
    let now = 1_000_000;
    const fetchJson = vi.fn(async () => ({
      status: 200,
      json: { git_endpoint: 'https://sync-eu.x/u', ttl: 3600 },
    }));
    const r = new HostResolver('https://sync.x', fetchJson, () => now);

    await r.resolve('tok');
    await r.resolve('tok');
    expect(fetchJson).toHaveBeenCalledTimes(1); // 2nd within ttl → cache

    now += 3600 * 1000 + 1; // past ttl
    await r.resolve('tok');
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('throws on 401 and re-fetches after invalidate()', async () => {
    let status = 401;
    const fetchJson = vi.fn(async () => ({ status, json: { git_endpoint: 'https://e/u' } }));
    const r = new HostResolver('https://sync.x', fetchJson, () => 0);
    await expect(r.resolve('bad')).rejects.toThrow('unauthorized');
    status = 200;
    r.invalidate();
    await expect(r.resolve('good')).resolves.toMatchObject({ gitEndpoint: 'https://e/u' });
  });
});
