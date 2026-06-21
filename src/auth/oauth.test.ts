import { describe, it, expect, vi } from 'vitest';
import {
  exchangeAuthCode,
  isTokenExpired,
  refreshTokens,
  registerClient,
  revokeToken,
  type HttpPost,
} from './oauth';

const ok = (json: unknown) => ({ status: 200, json });

describe('oauth (Better Auth AS contract)', () => {
  it('registerClient sends a public DCR body and returns client_id', async () => {
    const post: HttpPost = vi.fn(async () => ok({ client_id: 'cid-1' }));
    const id = await registerClient(post, 'https://auth.x/api/auth/mcp/register');
    expect(id).toBe('cid-1');
    const [url, init] = (post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/register');
    const body = JSON.parse(init.body);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toContain('refresh_token');
    expect(body.redirect_uris).toEqual(['obsidian://agentage-memory-cb']);
    expect(body.scope).toContain('offline_access');
  });

  it('registerClient throws on non-2xx or missing client_id', async () => {
    await expect(
      registerClient(
        vi.fn(async () => ({ status: 400, json: {} })),
        'u'
      )
    ).rejects.toThrow('DCR failed');
    await expect(
      registerClient(
        vi.fn(async () => ok({})),
        'u'
      )
    ).rejects.toThrow('DCR failed');
  });

  it('exchangeAuthCode posts a form body with code_verifier, no auth header, computes expiresAt', async () => {
    const post: HttpPost = vi.fn(async () =>
      ok({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
    );
    const t = await exchangeAuthCode(
      post,
      'https://auth.x/api/auth/mcp/token',
      'cid',
      'code1',
      'verifier1',
      1000
    );
    expect(t).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 1000 + 3600 * 1000 });
    const [, init] = (post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.Authorization).toBeUndefined();
    const p = new URLSearchParams(init.body);
    expect(p.get('grant_type')).toBe('authorization_code');
    expect(p.get('code_verifier')).toBe('verifier1');
    expect(p.get('client_id')).toBe('cid');
  });

  it('exchangeAuthCode surfaces error_description on failure', async () => {
    await expect(
      exchangeAuthCode(
        vi.fn(async () => ({ status: 400, json: { error_description: 'bad code' } })),
        'u',
        'c',
        'x',
        'v',
        0
      )
    ).rejects.toThrow('bad code');
  });

  it('refreshTokens posts grant_type=refresh_token and returns the rotated set', async () => {
    const post: HttpPost = vi.fn(async () =>
      ok({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 })
    );
    const t = await refreshTokens(post, 'u', 'cid', 'RT1', 0);
    expect(t.refreshToken).toBe('RT2');
    const p = new URLSearchParams((post as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(p.get('grant_type')).toBe('refresh_token');
    expect(p.get('refresh_token')).toBe('RT1');
  });

  it('revokeToken is best-effort (resolves even on non-2xx)', async () => {
    await expect(
      revokeToken(
        vi.fn(async () => ({ status: 500, json: null })),
        'u',
        'RT'
      )
    ).resolves.toBeUndefined();
  });

  it('isTokenExpired honors the skew window', () => {
    const t = { accessToken: 'a', refreshToken: 'r', expiresAt: 100_000 };
    expect(isTokenExpired(t, 0)).toBe(false);
    expect(isTokenExpired(t, 50_000)).toBe(true); // within 60s skew
    expect(isTokenExpired(t, 200_000)).toBe(true);
  });
});
