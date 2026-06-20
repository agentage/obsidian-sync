// Plugin configuration model — mirrors @agentage/memory-core's vaults.json
// (config/config.ts + contract/types.ts). One Obsidian vault == one memory-core
// vault entry. Pure (no `obsidian` import) so it stays unit-testable.

export type McpScope = 'local' | 'remote';

export interface OriginSettings {
  /** Remote git URL, e.g. https://sync.agentage.io/<user>/<vault>.git */
  remote: string;
  /** Auto-sync interval in minutes (0 = manual only). */
  interval: number;
  /** Glob patterns kept out of the synced repo. */
  ignore: string[];
}

export interface AgentageMemorySettings {
  /** memory-core vault name (the key in vaults.json). */
  vaultName: string;
  /** Local working-copy path. Empty = this Obsidian vault's folder. */
  path: string;
  /** Make this the `default` vault in vaults.json. */
  makeDefault: boolean;
  /** Turn on background sync to the remote (origin). */
  syncEnabled: boolean;
  origin: OriginSettings;
  /** Which scopes are exposed over MCP. */
  mcp: McpScope[];
  /** Dir holding vaults.json (memory-core: AGENTAGE_CONFIG_DIR or ~/.agentage). */
  configDir: string;
  /** UI only — reveal the advanced fields (not written to vaults.json). */
  showAdvanced: boolean;
  /** Plugin-local — the vault name last written to vaults.json, for renames. */
  writtenVaultName: string;
}

export const MCP_ENDPOINT = 'https://memory.agentage.io/mcp';
export const DEFAULT_REMOTE_HOST = 'https://sync.agentage.io';
export const VAULTS_SCHEMA_URL = 'https://memory.agentage.io/schema/vaults.json';
// The managed remote alias. memory-core resolves "agentage" to the cloud git URL
// using the OAuth token in ~/.agentage/auth.json (never stored in vaults.json).
export const AGENTAGE_REMOTE = 'agentage';

export const DEFAULT_SETTINGS: AgentageMemorySettings = {
  vaultName: 'personal',
  path: '',
  makeDefault: true,
  syncEnabled: false,
  origin: { remote: '', interval: 5, ignore: ['.obsidian', '.trash'] },
  mcp: ['local'],
  configDir: '~/.agentage',
  showAdvanced: false,
  writtenVaultName: '',
};

/** Trim + drop trailing slashes from a URL-ish value. */
export const normalizeRemote = (input: string): string => input.trim().replace(/\/+$/, '');

/** memory-core SAFE_SEGMENT shape: lowercase a-z 0-9 - _ , max 64 chars. */
export const normalizeVaultName = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

/** Parse a comma/newline list into trimmed, de-duped globs. */
export const parseIgnore = (input: string): string[] =>
  Array.from(new Set(input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)));

// ---- vaults.json preview (the exact shape memory-core validates) ----

export interface VaultEntryPreview {
  origin?: { remote: string; interval?: number; ignore?: string[] }[];
  path?: string;
  mcp?: McpScope[];
}

export interface VaultsConfigPreview {
  $schema: string;
  version: 1;
  default?: string;
  vaults: Record<string, VaultEntryPreview>;
}

/** Build the vaults.json entry these settings would write (for the live preview). */
export const buildVaultEntry = (s: AgentageMemorySettings, vaultRootPath: string): VaultEntryPreview => {
  const entry: VaultEntryPreview = { path: s.path.trim() || vaultRootPath };
  const remote = normalizeRemote(s.origin.remote);
  if (s.syncEnabled && remote) {
    const o: { remote: string; interval?: number; ignore?: string[] } = { remote };
    if (s.origin.interval > 0) o.interval = s.origin.interval;
    if (s.origin.ignore.length) o.ignore = [...s.origin.ignore];
    entry.origin = [o];
  }
  if (s.mcp.length) entry.mcp = [...s.mcp];
  return entry;
};

export const buildVaultsConfig = (s: AgentageMemorySettings, vaultRootPath: string): VaultsConfigPreview => {
  const name = normalizeVaultName(s.vaultName) || 'personal';
  return {
    $schema: VAULTS_SCHEMA_URL,
    version: 1,
    ...(s.makeDefault ? { default: name } : {}),
    vaults: { [name]: buildVaultEntry(s, vaultRootPath) },
  };
};

/** UI validation — mirrors memory-core validateConfig's two semantic rules. */
export const validateSettings = (s: AgentageMemorySettings): string[] => {
  const errs: string[] = [];
  if (!normalizeVaultName(s.vaultName)) errs.push('Vault name is required.');
  if (s.syncEnabled && !normalizeRemote(s.origin.remote))
    errs.push('Sync is on but no remote — click “Connect to agentage” or set a remote URL in Advanced.');
  // memory-core: a vault needs origin and/or path; path always defaults to the vault folder.
  return errs;
};
