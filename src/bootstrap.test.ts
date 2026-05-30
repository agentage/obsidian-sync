import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapFromResponse,
  bootstrapUrl,
  isBootstrapExpired,
  requestSyncBootstrap,
} from './bootstrap';
import type { HttpPost } from './oauth';

describe('bootstrapUrl', () => {
  it('appends the endpoint path to the API origin', () => {
    expect(bootstrapUrl('https://memory.agentage.io')).toBe(
      'https://memory.agentage.io/api/sync/bootstrap'
    );
  });

  it('trims trailing slashes', () => {
    expect(bootstrapUrl('https://memory.agentage.io//')).toBe(
      'https://memory.agentage.io/api/sync/bootstrap'
    );
  });
});

describe('bootstrapFromResponse', () => {
  it('maps a well-formed response with absolute expiresAt', () => {
    const r = bootstrapFromResponse(
      { syncUrl: 'https://sync.agentage.io', dbName: 'tenant-abc', token: 'tok', expiresAt: 5000 },
      1000
    );
    expect(r).toEqual({
      syncUrl: 'https://sync.agentage.io',
      dbName: 'tenant-abc',
      token: 'tok',
      expiresAt: 5000,
    });
  });

  it('derives expiresAt from relative expiresIn (seconds)', () => {
    const r = bootstrapFromResponse(
      { syncUrl: 'https://s', dbName: 'db', token: 't', expiresIn: 600 },
      1000
    );
    expect(r.expiresAt).toBe(1000 + 600 * 1000);
  });

  it('defaults to 1h when no expiry is given', () => {
    const r = bootstrapFromResponse({ syncUrl: 'https://s', dbName: 'db', token: 't' }, 0);
    expect(r.expiresAt).toBe(3600 * 1000);
  });

  it('throws when syncUrl/dbName/token are missing', () => {
    expect(() => bootstrapFromResponse({ syncUrl: 'https://s', dbName: 'db' }, 0)).toThrow(
      /missing/i
    );
    expect(() => bootstrapFromResponse({}, 0)).toThrow(/missing/i);
  });
});

describe('isBootstrapExpired', () => {
  const b = { syncUrl: 's', dbName: 'd', token: 't', expiresAt: 100_000 };
  it('is false well before expiry', () => {
    expect(isBootstrapExpired(b, 0)).toBe(false);
  });
  it('is true within the skew window', () => {
    expect(isBootstrapExpired(b, 100_000 - 30_000, 60_000)).toBe(true);
  });
  it('is true past expiry', () => {
    expect(isBootstrapExpired(b, 200_000)).toBe(true);
  });
});

describe('requestSyncBootstrap', () => {
  it('posts the bearer token and returns the parsed target', async () => {
    const post: HttpPost = vi.fn(async () => ({
      status: 200,
      json: {
        syncUrl: 'https://sync.agentage.io',
        dbName: 'db',
        token: 'couch-jwt',
        expiresIn: 900,
      },
    }));
    const r = await requestSyncBootstrap(post, 'https://memory.agentage.io', 'access-123', 1000);
    expect(post).toHaveBeenCalledWith('https://memory.agentage.io/api/sync/bootstrap', {
      headers: { Authorization: 'Bearer access-123', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.token).toBe('couch-jwt');
    expect(r.expiresAt).toBe(1000 + 900 * 1000);
  });

  it('throws with the server-provided error on non-2xx', async () => {
    const post: HttpPost = async () => ({ status: 401, json: { error: 'invalid token' } });
    await expect(
      requestSyncBootstrap(post, 'https://memory.agentage.io', 'bad', 0)
    ).rejects.toThrow(/invalid token/);
  });
});
