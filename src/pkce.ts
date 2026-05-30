/**
 * PKCE (RFC 7636) primitives + GoTrue authorize-URL/callback helpers. Pure and
 * dependency-free (uses Web Crypto globals available in Electron + Node), so
 * the crypto + URL logic is unit-tested without the Obsidian runtime.
 */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A high-entropy code verifier (43-char base64url of 32 random bytes). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** The S256 code challenge = base64url(SHA-256(verifier)). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export interface AuthorizeParams {
  authBase: string;
  redirectUri: string;
  provider: string;
  codeChallenge: string;
}

/** Build the GoTrue `/authorize` URL for a social provider PKCE flow. */
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(`${params.authBase.replace(/\/+$/, '')}/authorize`);
  url.searchParams.set('provider', params.provider);
  url.searchParams.set('redirect_to', params.redirectUri);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 's256');
  return url.toString();
}

export type CallbackResult = { code: string } | { error: string };

/** Extract the auth code (or error) from the `obsidian://…-cb` callback params. */
export function parseCallbackParams(params: Record<string, string>): CallbackResult {
  if (params.error) return { error: params.error_description || params.error };
  if (params.code) return { code: params.code };
  return { error: 'No authorization code in callback' };
}
