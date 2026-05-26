export interface AgentageMemorySettings {
  serverUrl: string;
}

export const DEFAULT_SETTINGS: AgentageMemorySettings = {
  serverUrl: 'https://mcp.agentage.io',
};

/** Trim whitespace and any trailing slashes from a server URL. */
export function normalizeServerUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}
