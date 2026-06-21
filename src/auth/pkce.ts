// Pure PKCE + authorize-URL helpers. Web Crypto only (Electron + Node), no Obsidian.
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** High-entropy verifier: 43-char base64url of 32 random bytes (RFC 7636). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** S256 challenge = base64url(SHA-256(verifier)). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/** Random opaque state (CSRF + flow correlation). */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export interface AuthorizeParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string; // byte-exact match at the token endpoint
  codeChallenge: string;
  state: string;
  scope?: string; // MUST include offline_access for a refresh token
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const url = new URL(p.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', p.scope ?? 'memory:read memory:write offline_access');
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', p.state);
  return url.toString();
}

export type CallbackResult = { code: string; state: string } | { error: string };

/** Extract code+state (or error) from the obsidian:// callback params. */
export function parseCallbackParams(params: Record<string, string>): CallbackResult {
  if (params.error) return { error: params.error_description || params.error };
  if (params.code && params.state) return { code: params.code, state: params.state };
  return { error: 'No authorization code/state in callback' };
}
