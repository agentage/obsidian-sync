import { describe, it, expect, vi } from 'vitest';
import { createAuthFlow, type AuthFlowDeps } from './auth-flow';
import type { AuthStore } from './token-store';
import type { TokenSet } from './oauth';

const DISCOVERY = {
  registration_endpoint: 'https://auth.x/api/auth/mcp/register',
  authorization_endpoint: 'https://auth.x/api/auth/mcp/authorize',
  token_endpoint: 'https://auth.x/api/auth/mcp/token',
  revocation_endpoint: 'https://auth.x/api/auth/mcp/revoke',
};
const NOW = 1_000_000;

function fakeStore(tokens: TokenSet | null = null, clientId: string | null = null): AuthStore {
  return {
    load: () => tokens,
    getClientId: () => clientId,
    setClientId: (id) => {
      clientId = id;
    },
    save: async (t) => {
      tokens = t;
    },
    clear: async () => {
      tokens = null;
      clientId = null;
    },
  };
}

function flow(store: AuthStore, post: AuthFlowDeps['post'], extras?: Partial<AuthFlowDeps>) {
  const captured: { url?: string } = {};
  const f = createAuthFlow({
    store,
    post,
    getJson: async () => ({ status: 200, json: DISCOVERY }),
    authOrigin: () => 'https://auth.x',
    notify: vi.fn(),
    openExternal: (url) => {
      captured.url = url;
    },
    now: () => NOW,
    ...extras,
  });
  return { f, captured };
}

describe('auth-flow', () => {
  it('startSignIn → handleCallback exchanges the code and stores tokens', async () => {
    const store = fakeStore();
    const post = vi.fn(async (url: string) =>
      url.includes('/register')
        ? { status: 200, json: { client_id: 'cid' } }
        : { status: 200, json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } }
    );
    const { f, captured } = flow(store, post);

    await f.startSignIn();
    expect(store.getClientId()).toBe('cid');
    const state = new URL(captured.url!).searchParams.get('state')!;
    expect(state).toBeTruthy();

    await f.handleCallback({ code: 'c', state });
    expect(store.load()).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: NOW + 3600 * 1000,
    });
    expect(f.isSignedIn()).toBe(true);
  });

  it('rejects a callback whose state does not match (no token stored)', async () => {
    const store = fakeStore();
    const notify = vi.fn();
    const post = vi.fn(async () => ({ status: 200, json: { client_id: 'cid' } }));
    const { f } = flow(store, post, { notify });
    await f.startSignIn();
    await f.handleCallback({ code: 'c', state: 'WRONG' });
    expect(store.load()).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('state mismatch'));
  });

  it('getValidToken refreshes when expired and persists the rotated set', async () => {
    const store = fakeStore({ accessToken: 'AT0', refreshToken: 'RT0', expiresAt: NOW - 1 }, 'cid');
    const post = vi.fn(async () => ({
      status: 200,
      json: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 },
    }));
    const { f } = flow(store, post);
    const tok = await f.getValidToken();
    expect(tok).toBe('AT2');
    expect(store.load()?.refreshToken).toBe('RT2');
  });

  it('getValidToken returns the live token without refreshing, and null when signed out', async () => {
    const live = fakeStore(
      { accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW + 3600 * 1000 },
      'cid'
    );
    const post = vi.fn(async () => ({ status: 500, json: null }));
    expect(await flow(live, post).f.getValidToken()).toBe('AT');
    expect(post).not.toHaveBeenCalled();
    expect(await flow(fakeStore(), post).f.getValidToken()).toBeNull();
  });

  it('getValidToken clears the dead session (and notifies onChange) on a 4xx refresh', async () => {
    const store = fakeStore({ accessToken: 'AT0', refreshToken: 'RT0', expiresAt: NOW - 1 }, 'cid');
    const post = vi.fn(async () => ({ status: 400, json: { error: 'invalid_grant' } }));
    const onChange = vi.fn();
    const notify = vi.fn();
    const tok = await flow(store, post, { onChange, notify }).f.getValidToken();
    expect(tok).toBeNull();
    expect(store.load()).toBeNull(); // session cleared → UI flips to signed-out
    expect(onChange).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('session expired'));
  });

  it('getValidToken keeps tokens on a transient 5xx refresh (retryable, not a sign-out)', async () => {
    const store = fakeStore({ accessToken: 'AT0', refreshToken: 'RT0', expiresAt: NOW - 1 }, 'cid');
    const post = vi.fn(async () => ({ status: 503, json: null }));
    const onChange = vi.fn();
    const tok = await flow(store, post, { onChange }).f.getValidToken();
    expect(tok).toBeNull();
    expect(store.load()).not.toBeNull(); // tokens preserved
    expect(onChange).not.toHaveBeenCalled();
  });

  it('loopback sign-in: DCR, authorize, and token exchange all use the bound redirect', async () => {
    const store = fakeStore();
    const post = vi.fn(async (url: string, _init: { body: string }) =>
      url.includes('/register')
        ? { status: 201, json: { client_id: 'cid' } }
        : { status: 200, json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } }
    );
    const redirectUri = 'http://127.0.0.1:55555/callback';
    let resolveCode!: (p: Record<string, string>) => void;
    const waitForCode = new Promise<Record<string, string>>((r) => (resolveCode = r));
    const close = vi.fn();
    const loopback = vi.fn(async () => ({ redirectUri, waitForCode, close }));

    const captured: { url?: string } = {};
    const f = createAuthFlow({
      store,
      post,
      getJson: async () => ({ status: 200, json: DISCOVERY }),
      authOrigin: () => 'https://auth.x',
      notify: vi.fn(),
      // The browser "redirects" to the listener with the same state the authorize URL carried.
      openExternal: (url) => {
        captured.url = url;
        resolveCode({ code: 'c', state: new URL(url).searchParams.get('state')! });
      },
      now: () => NOW,
      loopback,
    });

    await f.startSignIn();

    const regBody = JSON.parse(post.mock.calls.find(([u]) => u.includes('/register'))![1].body);
    expect(regBody.redirect_uris).toEqual([redirectUri]);
    expect(new URL(captured.url!).searchParams.get('redirect_uri')).toBe(redirectUri);
    const tokenBody = new URLSearchParams(
      post.mock.calls.find(([u]) => u.includes('/token'))![1].body
    );
    expect(tokenBody.get('redirect_uri')).toBe(redirectUri);
    expect(store.load()).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: NOW + 3600 * 1000,
    });
    expect(f.isSignedIn()).toBe(true);
    expect(close).toHaveBeenCalled(); // listener always torn down
  });

  it('loopback sign-in rejects a state mismatch and stores no token (listener closed)', async () => {
    const store = fakeStore();
    const post = vi.fn(async (url: string, _init: { body: string }) =>
      url.includes('/register')
        ? { status: 201, json: { client_id: 'cid' } }
        : { status: 200, json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } }
    );
    const close = vi.fn();
    const loopback = vi.fn(async () => ({
      redirectUri: 'http://127.0.0.1:5/callback',
      waitForCode: Promise.resolve({ code: 'c', state: 'FORGED' }),
      close,
    }));
    const notify = vi.fn();
    const f = createAuthFlow({
      store,
      post,
      getJson: async () => ({ status: 200, json: DISCOVERY }),
      authOrigin: () => 'https://auth.x',
      notify,
      openExternal: () => {},
      now: () => NOW,
      loopback,
    });

    await f.startSignIn();
    expect(store.load()).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('state mismatch'));
    expect(close).toHaveBeenCalled();
  });
});
