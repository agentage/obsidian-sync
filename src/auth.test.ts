import { describe, expect, it } from 'vitest';
import { basicAuthProvider, bearerAuthProvider } from './auth';

describe('basicAuthProvider', () => {
  it('builds a Basic header from username:password', async () => {
    const provider = basicAuthProvider('admin', 'agentage');
    expect(await provider.authHeader()).toBe('Basic ' + btoa('admin:agentage'));
  });

  it('encodes credentials containing a colon', async () => {
    const provider = basicAuthProvider('user', 'p:ss:word');
    expect(await provider.authHeader()).toBe('Basic ' + btoa('user:p:ss:word'));
  });
});

describe('bearerAuthProvider', () => {
  it('builds a Bearer header from the current token', async () => {
    const provider = bearerAuthProvider(() => 'couch-jwt');
    expect(await provider.authHeader()).toBe('Bearer couch-jwt');
  });

  it('reads the token on each call (refresh without rebuilding)', async () => {
    let token = 'first';
    const provider = bearerAuthProvider(() => token);
    expect(await provider.authHeader()).toBe('Bearer first');
    token = 'second';
    expect(await provider.authHeader()).toBe('Bearer second');
  });

  it('returns null (unauthenticated) when there is no token', async () => {
    expect(await bearerAuthProvider(() => null).authHeader()).toBeNull();
  });
});
