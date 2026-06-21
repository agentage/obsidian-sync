// Pure OAuth metadata discovery. fetch injected (mock in tests). The AS's well-known
// endpoints already carry the /api/auth/mcp/ prefix — do not re-prefix.
import type { OAuthEndpoints } from './oauth';

export type GetJson = (url: string) => Promise<{ status: number; json: unknown }>;

export async function discoverEndpoints(
  authOrigin: string,
  getJson: GetJson
): Promise<OAuthEndpoints> {
  const url = `${authOrigin.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`;
  const res = await getJson(url);
  if (res.status < 200 || res.status >= 300) throw new Error(`discovery: HTTP ${res.status}`);
  const d = (res.json ?? {}) as Record<string, string>;
  if (!d.authorization_endpoint || !d.token_endpoint || !d.registration_endpoint) {
    throw new Error('discovery: missing endpoints');
  }
  return {
    registrationEndpoint: d.registration_endpoint,
    authorizationEndpoint: d.authorization_endpoint,
    tokenEndpoint: d.token_endpoint,
    revocationEndpoint: d.revocation_endpoint,
  };
}
