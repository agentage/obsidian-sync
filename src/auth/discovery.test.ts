import { describe, it, expect } from 'vitest';
import { discoverEndpoints } from './discovery';

const DOC = {
  issuer: 'https://auth.x',
  registration_endpoint: 'https://auth.x/api/auth/mcp/register',
  authorization_endpoint: 'https://auth.x/api/auth/mcp/authorize',
  token_endpoint: 'https://auth.x/api/auth/mcp/token',
  revocation_endpoint: 'https://auth.x/api/auth/mcp/revoke',
};

describe('discovery', () => {
  it('returns the four endpoints (already mcp-prefixed)', async () => {
    const ep = await discoverEndpoints('https://auth.x/', async (url) => {
      expect(url).toBe('https://auth.x/.well-known/oauth-authorization-server');
      return { status: 200, json: DOC };
    });
    expect(ep.tokenEndpoint).toContain('/api/auth/mcp/token');
    expect(ep.revocationEndpoint).toContain('/revoke');
  });

  it('throws on non-2xx or missing endpoints', async () => {
    await expect(
      discoverEndpoints('https://auth.x', async () => ({ status: 503, json: null }))
    ).rejects.toThrow('HTTP 503');
    await expect(
      discoverEndpoints('https://auth.x', async () => ({ status: 200, json: {} }))
    ).rejects.toThrow('missing endpoints');
  });
});
