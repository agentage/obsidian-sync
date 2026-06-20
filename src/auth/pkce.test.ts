import { describe, it, expect } from 'vitest';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  parseCallbackParams,
} from './pkce';

describe('pkce', () => {
  it('deriveCodeChallenge matches the RFC 7636 Appendix B S256 vector', async () => {
    const challenge = await deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generateCodeVerifier is 43-char base64url and unique', () => {
    const a = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(generateCodeVerifier());
  });

  it('generateState is non-empty base64url and unique', () => {
    const a = generateState();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(generateState());
  });

  it('buildAuthorizeUrl sets the required params + S256 + offline_access', () => {
    const u = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: 'https://auth.x/api/auth/mcp/authorize',
        clientId: 'cid',
        redirectUri: 'obsidian://agentage-memory-cb',
        codeChallenge: 'chal',
        state: 'st',
      })
    );
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe('obsidian://agentage-memory-cb');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('offline_access');
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('parseCallbackParams returns code+state, prefers error_description, rejects incomplete', () => {
    expect(parseCallbackParams({ code: 'c', state: 's' })).toEqual({ code: 'c', state: 's' });
    expect(parseCallbackParams({ error: 'access_denied', error_description: 'nope' })).toEqual({
      error: 'nope',
    });
    expect(parseCallbackParams({ code: 'c' })).toHaveProperty('error');
  });
});
