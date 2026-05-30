/**
 * GoTrue OAuth token exchange + refresh. The HTTP transport is injected as an
 * `HttpPost`, so the request shaping, response parsing, and expiry logic are
 * unit-tested with a fake — no network, no Obsidian. The Obsidian-backed
 * transport (`requestUrl`) is wired in `auth-flow.ts`.
 */

export interface OAuthConfig {
  /** GoTrue base, e.g. https://memory.agentage.io/auth/v1 */
  authBase: string;
  /** Public Supabase anon key — sent as the `apikey`/Bearer on auth requests. */
  anonKey: string;
  /** Plugin callback, e.g. obsidian://agentage-memory-cb */
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
}

export interface TokenHttpResponse {
  status: number;
  json: unknown;
}

export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string }
) => Promise<TokenHttpResponse>;

function tokenUrl(authBase: string, grant: string): string {
  return `${authBase.replace(/\/+$/, '')}/token?grant_type=${grant}`;
}

/** Map a GoTrue token response body to a `TokenSet`; throws if malformed. */
export function tokenSetFromResponse(json: unknown, nowMs: number): TokenSet {
  const body = (json ?? {}) as Record<string, unknown>;
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  if (!accessToken || !refreshToken) {
    throw new Error('Token response missing access/refresh token');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000 };
}

async function postToken(
  post: HttpPost,
  cfg: OAuthConfig,
  grant: string,
  body: Record<string, string>,
  nowMs: number
): Promise<TokenSet> {
  const res = await post(tokenUrl(cfg.authBase, grant), {
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status < 200 || res.status >= 300) {
    const detail =
      (res.json as { error_description?: string; msg?: string } | null)?.error_description ??
      (res.json as { msg?: string } | null)?.msg ??
      `HTTP ${res.status}`;
    throw new Error(`Token request failed: ${detail}`);
  }
  return tokenSetFromResponse(res.json, nowMs);
}

/** Exchange a PKCE auth code for tokens (`grant_type=pkce`). */
export function exchangeAuthCode(
  post: HttpPost,
  cfg: OAuthConfig,
  code: string,
  verifier: string,
  nowMs: number
): Promise<TokenSet> {
  return postToken(post, cfg, 'pkce', { auth_code: code, code_verifier: verifier }, nowMs);
}

/** Trade a refresh token for a fresh `TokenSet` (`grant_type=refresh_token`). */
export function refreshTokens(
  post: HttpPost,
  cfg: OAuthConfig,
  refreshToken: string,
  nowMs: number
): Promise<TokenSet> {
  return postToken(post, cfg, 'refresh_token', { refresh_token: refreshToken }, nowMs);
}

/** True when the token is expired or within `skewMs` of expiring. */
export function isTokenExpired(tokens: TokenSet, nowMs: number, skewMs = 60_000): boolean {
  return nowMs + skewMs >= tokens.expiresAt;
}
