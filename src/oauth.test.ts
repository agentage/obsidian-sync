import { describe, expect, it, vi } from 'vitest';
import {
  exchangeAuthCode,
  isTokenExpired,
  refreshTokens,
  tokenSetFromResponse,
  type HttpPost,
  type OAuthConfig,
} from './oauth';

const CFG: OAuthConfig = {
  authBase: 'https://memory.agentage.io/auth/v1',
  anonKey: 'anon-123',
  redirectUri: 'obsidian://agentage-memory-cb',
};

const okBody = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 };

describe('oauth', () => {
  describe('tokenSetFromResponse', () => {
    it('computes an absolute expiry from expires_in', () => {
      expect(tokenSetFromResponse(okBody, 1_000)).toEqual({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 1_000 + 3600 * 1000,
      });
    });

    it('throws when tokens are missing', () => {
      expect(() => tokenSetFromResponse({ access_token: 'at' }, 0)).toThrow(/missing/);
    });
  });

  describe('exchangeAuthCode', () => {
    it('POSTs grant_type=pkce with the verifier + anon-key headers', async () => {
      const post = vi.fn<HttpPost>().mockResolvedValue({ status: 200, json: okBody });
      const tokens = await exchangeAuthCode(post, CFG, 'the-code', 'the-verifier', 5_000);

      expect(tokens.accessToken).toBe('at');
      const [url, init] = post.mock.calls[0];
      expect(url).toBe('https://memory.agentage.io/auth/v1/token?grant_type=pkce');
      expect(init.headers.apikey).toBe('anon-123');
      expect(JSON.parse(init.body)).toEqual({
        auth_code: 'the-code',
        code_verifier: 'the-verifier',
      });
    });

    it('throws the GoTrue error_description on a non-2xx response', async () => {
      const post = vi
        .fn<HttpPost>()
        .mockResolvedValue({ status: 400, json: { error_description: 'bad code' } });
      await expect(exchangeAuthCode(post, CFG, 'x', 'y', 0)).rejects.toThrow(/bad code/);
    });
  });

  describe('refreshTokens', () => {
    it('POSTs grant_type=refresh_token', async () => {
      const post = vi.fn<HttpPost>().mockResolvedValue({ status: 200, json: okBody });
      await refreshTokens(post, CFG, 'old-rt', 0);
      const [url, init] = post.mock.calls[0];
      expect(url).toBe('https://memory.agentage.io/auth/v1/token?grant_type=refresh_token');
      expect(JSON.parse(init.body)).toEqual({ refresh_token: 'old-rt' });
    });
  });

  describe('isTokenExpired', () => {
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 100_000 };
    it('is false well before expiry', () => {
      expect(isTokenExpired(tokens, 0)).toBe(false);
    });
    it('is true within the skew window', () => {
      expect(isTokenExpired(tokens, 100_000 - 30_000, 60_000)).toBe(true);
    });
    it('is true after expiry', () => {
      expect(isTokenExpired(tokens, 200_000)).toBe(true);
    });
  });
});
