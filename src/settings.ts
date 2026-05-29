export interface AgentageMemorySettings {
  serverUrl: string;
  /** CouchDB database name. Configurable so e2e tests and future per-vault
   * setups can target an isolated DB on the same server. */
  dbName: string;
}

// Credentials (username/password) live in `app.secretStorage`, never plaintext
// `data.json` — see credentials.ts.
export const DEFAULT_SETTINGS: AgentageMemorySettings = {
  serverUrl: 'https://mcp.agentage.io',
  dbName: 'agentage-memory',
};

/** Trim whitespace and any trailing slashes from a server URL. */
export function normalizeServerUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}
