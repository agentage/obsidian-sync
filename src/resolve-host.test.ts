import { describe, it, expect, vi } from 'vitest';
import { HostResolver, parseResolution, buildRepoUrl, channelForVault } from './resolve-host';

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

describe('resolve-host — couch channel parsing (additive)', () => {
  const couchPayload = {
    git_endpoint: 'https://sync.x/u',
    vaults: ['notes'],
    couch_endpoint: 'https://couch.x',
    couch_token_url: 'https://auth.x/account/couch-token',
    couch_vaults: [{ vault: 'work', db: 'mem_abc' }],
  };

  it('parses couch fields when endpoint + token url + vaults are all present', () => {
    const r = parseResolution(couchPayload);
    expect(r.vaults).toEqual(['notes']);
    expect(r.couchEndpoint).toBe('https://couch.x');
    expect(r.couchTokenUrl).toBe('https://auth.x/account/couch-token');
    expect(r.couchVaults).toEqual([{ vault: 'work', db: 'mem_abc' }]);
  });

  it('degrades to git-only when the payload has no couch fields (old server)', () => {
    const r = parseResolution({ git_endpoint: 'https://sync.x/u', vaults: ['notes', 'work'] });
    expect(r.couchEndpoint).toBeUndefined();
    expect(r.couchTokenUrl).toBeUndefined();
    expect(r.couchVaults).toBeUndefined();
  });

  it('drops a partial couch advert (missing token url) rather than half-enabling it', () => {
    const r = parseResolution({ ...couchPayload, couch_token_url: undefined });
    expect(r.couchEndpoint).toBeUndefined();
    expect(r.couchVaults).toBeUndefined();
  });

  it('filters malformed couch_vault entries; empties collapse to git-only', () => {
    const r = parseResolution({
      ...couchPayload,
      couch_vaults: [{ vault: 'work' }, { db: 'x' }, 42, null],
    });
    expect(r.couchVaults).toBeUndefined();
    expect(r.couchEndpoint).toBeUndefined();
  });

  it('channelForVault routes a couch vault to couch and everything else to git', () => {
    const r = parseResolution(couchPayload);
    expect(channelForVault(r, 'work')).toEqual({
      channel: 'couch',
      endpoint: 'https://couch.x',
      db: 'mem_abc',
      tokenUrl: 'https://auth.x/account/couch-token',
    });
    expect(channelForVault(r, 'notes')).toEqual({ channel: 'git' });
  });

  it('channelForVault is git for a git-only resolution', () => {
    const r = parseResolution({ git_endpoint: 'https://sync.x/u', vaults: ['notes'] });
    expect(channelForVault(r, 'notes')).toEqual({ channel: 'git' });
  });
});
