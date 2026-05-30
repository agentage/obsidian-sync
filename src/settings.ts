export interface AgentageMemorySettings {
  serverUrl: string;
  /** CouchDB database name. Configurable so e2e tests and future per-vault
   * setups can target an isolated DB on the same server. */
  dbName: string;
  /** GoTrue auth base for OAuth sign-in, e.g. https://dev.agentage.io/auth/v1 */
  authBase: string;
  /** Public Supabase anon key for the auth endpoint (public by design). */
  anonKey: string;
}

// Secrets (CouchDB password, OAuth access/refresh tokens) live in
// `app.secretStorage`, never plaintext `data.json` — see credentials.ts /
// token-store.ts. `anonKey` is a *public* key, so it stays in settings.
export const DEFAULT_SETTINGS: AgentageMemorySettings = {
  serverUrl: 'https://mcp.agentage.io',
  dbName: 'agentage-memory',
  authBase: 'https://dev.agentage.io/auth/v1',
  anonKey: '',
};

/** Trim whitespace and any trailing slashes from a server URL. */
export function normalizeServerUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}
