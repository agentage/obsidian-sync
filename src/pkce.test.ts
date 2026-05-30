import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  parseCallbackParams,
} from './pkce';

describe('pkce', () => {
  describe('deriveCodeChallenge', () => {
    it('matches the RFC 7636 Appendix B test vector', async () => {
      // verifier → S256 challenge from RFC 7636.
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      expect(await deriveCodeChallenge(verifier)).toBe(
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
      );
    });
  });

  describe('generateCodeVerifier', () => {
    it('produces a 43-char base64url string with no padding', () => {
      const v = generateCodeVerifier();
      expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('is different each call', () => {
      expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('builds a GoTrue social PKCE authorize URL', () => {
      const url = new URL(
        buildAuthorizeUrl({
          authBase: 'https://memory.agentage.io/auth/v1/',
          redirectUri: 'obsidian://agentage-memory-cb',
          provider: 'github',
          codeChallenge: 'CHAL',
        })
      );
      expect(url.origin + url.pathname).toBe('https://memory.agentage.io/auth/v1/authorize');
      expect(url.searchParams.get('provider')).toBe('github');
      expect(url.searchParams.get('redirect_to')).toBe('obsidian://agentage-memory-cb');
      expect(url.searchParams.get('code_challenge')).toBe('CHAL');
      expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    });
  });

  describe('parseCallbackParams', () => {
    it('returns the code on success', () => {
      expect(parseCallbackParams({ action: 'x', code: 'abc' })).toEqual({ code: 'abc' });
    });

    it('prefers error_description over error', () => {
      expect(
        parseCallbackParams({ action: 'x', error: 'access_denied', error_description: 'nope' })
      ).toEqual({
        error: 'nope',
      });
    });

    it('reports a missing code as an error', () => {
      expect(parseCallbackParams({ action: 'x' })).toEqual({
        error: 'No authorization code in callback',
      });
    });
  });
});
