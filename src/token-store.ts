/**
 * OAuth token persistence in Obsidian's encrypted `app.secretStorage` (never
 * plaintext `data.json`). Obsidian-free — takes the `SecretStore` adapter — so
 * it's unit-tested with an in-memory fake.
 */
import type { SecretStore } from './credentials';
import type { TokenSet } from './oauth';

export const ACCESS_TOKEN_SECRET = 'agentage-memory-access-token';
export const REFRESH_TOKEN_SECRET = 'agentage-memory-refresh-token';
export const EXPIRES_AT_SECRET = 'agentage-memory-token-expires-at';

export function saveTokens(store: SecretStore, tokens: TokenSet): void {
  store.set(ACCESS_TOKEN_SECRET, tokens.accessToken);
  store.set(REFRESH_TOKEN_SECRET, tokens.refreshToken);
  store.set(EXPIRES_AT_SECRET, String(tokens.expiresAt));
}

/** The stored `TokenSet`, or null when not signed in (or after `clearTokens`). */
export function loadTokens(store: SecretStore): TokenSet | null {
  const accessToken = store.get(ACCESS_TOKEN_SECRET);
  const refreshToken = store.get(REFRESH_TOKEN_SECRET);
  if (!accessToken || !refreshToken) return null;
  const expiresAt = Number(store.get(EXPIRES_AT_SECRET));
  return { accessToken, refreshToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 };
}

/** Clear stored tokens. SecretStorage has no delete, so we blank the values. */
export function clearTokens(store: SecretStore): void {
  store.set(ACCESS_TOKEN_SECRET, '');
  store.set(REFRESH_TOKEN_SECRET, '');
  store.set(EXPIRES_AT_SECRET, '');
}
