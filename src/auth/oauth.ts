// Pure OAuth client for the Better Auth AS (verified contract 2026-06-20): public PKCE
// client, form-urlencoded token endpoint, grant_type=authorization_code, NO client auth
// header. HTTP injected as HttpPost (mock in tests).

export interface OAuthEndpoints {
  registrationEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

// Carries the HTTP status so callers can tell a rejected grant (4xx — clear the session)
// from a transient/server error (5xx/network — keep tokens, retry later).
export class OAuthHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'OAuthHttpError';
  }
}
export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string }
) => Promise<HttpResponse>;

export const REDIRECT_URI = 'obsidian://agentage-memory-cb';
const SCOPE = 'memory:read memory:write offline_access';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** DCR (RFC 7591). Returns the public client_id (no secret). Run once per setup. */
export async function registerClient(
  post: HttpPost,
  registrationEndpoint: string,
  redirectUri = REDIRECT_URI
): Promise<string> {
  const res = await post(registrationEndpoint, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Agentage Memory (Obsidian)',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    }),
  });
  const body = (res.json ?? {}) as { client_id?: string };
  if (res.status < 200 || res.status >= 300 || !body.client_id)
    throw new Error(`DCR failed: HTTP ${res.status}`);
  return body.client_id;
}

function tokenSetFromResponse(json: unknown, nowMs: number): TokenSet {
  const b = (json ?? {}) as Record<string, unknown>;
  const accessToken = typeof b.access_token === 'string' ? b.access_token : '';
  const refreshToken = typeof b.refresh_token === 'string' ? b.refresh_token : '';
  if (!accessToken || !refreshToken) throw new Error('Token response missing access/refresh token');
  const expiresIn = typeof b.expires_in === 'number' ? b.expires_in : 3600;
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000 };
}

async function postToken(
  post: HttpPost,
  tokenEndpoint: string,
  body: Record<string, string>,
  nowMs: number
): Promise<TokenSet> {
  const res = await post(tokenEndpoint, { headers: FORM, body: form(body) });
  if (res.status < 200 || res.status >= 300) {
    const d = res.json as { error_description?: string; error?: string } | null;
    throw new OAuthHttpError(
      res.status,
      `Token request failed: ${d?.error_description ?? d?.error ?? `HTTP ${res.status}`}`
    );
  }
  return tokenSetFromResponse(res.json, nowMs);
}

/** Exchange a PKCE auth code for tokens. */
export function exchangeAuthCode(
  post: HttpPost,
  tokenEndpoint: string,
  clientId: string,
  code: string,
  verifier: string,
  nowMs: number,
  redirectUri = REDIRECT_URI
): Promise<TokenSet> {
  return postToken(
    post,
    tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    },
    nowMs
  );
}

/** Refresh (rotates BOTH tokens — persist the new refresh_token). */
export function refreshTokens(
  post: HttpPost,
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  nowMs: number
): Promise<TokenSet> {
  return postToken(
    post,
    tokenEndpoint,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
    nowMs
  );
}

/** Optional RFC 7009 revoke (always 200). Best-effort on disconnect. */
export async function revokeToken(
  post: HttpPost,
  revocationEndpoint: string,
  token: string
): Promise<void> {
  await post(revocationEndpoint, { headers: FORM, body: form({ token }) });
}

/** True when expired or within skewMs of expiring. */
export function isTokenExpired(t: TokenSet, nowMs: number, skewMs = 60_000): boolean {
  return nowMs + skewMs >= t.expiresAt;
}
