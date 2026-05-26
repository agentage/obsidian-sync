export interface AgentageMemorySettings {
  serverUrl: string;
  username: string;
  password: string;
}

export const DEFAULT_SETTINGS: AgentageMemorySettings = {
  serverUrl: 'https://mcp.agentage.io',
  // Dev defaults match the local CouchDB shipped in docker-compose.yml.
  // These move to app.secretStorage when OAuth lands; until then,
  // they live in plaintext data.json — use only for local development.
  username: 'admin',
  password: 'agentage',
};

/** Trim whitespace and any trailing slashes from a server URL. */
export function normalizeServerUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}
