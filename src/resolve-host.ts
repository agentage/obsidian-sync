// Host resolution (R7): the plugin knows one bootstrap host and resolves its
// per-user/per-region git endpoint from GET /.well-known/agentage-sync, caching it
// for the response ttl (default 1h). fetch + clock are INJECTED so it unit-tests in
// Node without Obsidian or a live server.

// A couch-channel memory advertised in the resolution: its per-memory db on the shared
// cluster. The JWT is NOT here - the client mints it from `couchTokenUrl` (the auth
// service is the sole minter). Mirrors @agentage/sync's CouchVault (server contract).
export interface CouchVaultResolution {
  vault: string;
  db: string;
}

export interface SyncResolution {
  gitEndpoint: string;
  region: string;
  vaults: string[];
  ttl: number;
  // Present only when the user has >=1 couch-channel memory. A vault appears in EITHER
  // `vaults` (git) or `couchVaults` (couch), never both - one channel per memory. Absent
  // => today's git-only shape, parsed exactly as before (old-server back-compat).
  couchEndpoint?: string;
  couchTokenUrl?: string;
  couchVaults?: CouchVaultResolution[];
}

/** The sync channel a resolved memory uses. Exactly one per memory. */
export type VaultChannel =
  { channel: 'git' } | { channel: 'couch'; endpoint: string; db: string; tokenUrl: string };

export type FetchJson = (url: string, token: string) => Promise<{ status: number; json: unknown }>;
export type Clock = () => number;

const WELL_KNOWN = '/.well-known/agentage-sync';

// Server field names (packages/sync/src/resolution.ts): couch_endpoint, couch_token_url,
// couch_vaults[{ vault, db }]. Parsed only when all three are present + well-formed, so a
// partial/old payload degrades to git rather than half-advertising a couch channel.
function parseCouchVault(raw: unknown): CouchVaultResolution | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.vault !== 'string' || !o.vault) return null;
  if (typeof o.db !== 'string' || !o.db) return null;
  return { vault: o.vault, db: o.db };
}

export function parseResolution(raw: unknown): SyncResolution {
  if (!raw || typeof raw !== 'object') throw new Error('resolution: not an object');
  const r = raw as Record<string, unknown>;
  const gitEndpoint = r.git_endpoint;
  if (typeof gitEndpoint !== 'string' || !gitEndpoint)
    throw new Error('resolution: missing git_endpoint');
  const region = typeof r.region === 'string' ? r.region : 'default';
  const vaults = Array.isArray(r.vaults)
    ? r.vaults.filter((v): v is string => typeof v === 'string')
    : [];
  const ttl = typeof r.ttl === 'number' && r.ttl > 0 ? r.ttl : 3600;
  const base: SyncResolution = { gitEndpoint, region, vaults, ttl };
  const couchEndpoint = typeof r.couch_endpoint === 'string' ? r.couch_endpoint : '';
  const couchTokenUrl = typeof r.couch_token_url === 'string' ? r.couch_token_url : '';
  const couchVaults = Array.isArray(r.couch_vaults)
    ? r.couch_vaults.map(parseCouchVault).filter((v): v is CouchVaultResolution => v !== null)
    : [];
  if (couchEndpoint && couchTokenUrl && couchVaults.length) {
    base.couchEndpoint = couchEndpoint;
    base.couchTokenUrl = couchTokenUrl;
    base.couchVaults = couchVaults;
  }
  return base;
}

/** Which sync channel a resolved memory uses. A vault named in `couchVaults` is on the
 * couch channel (endpoint/db/tokenUrl attached); everything else defaults to git. */
export function channelForVault(res: SyncResolution, vault: string): VaultChannel {
  const couch = res.couchVaults?.find((v) => v.vault === vault);
  if (couch && res.couchEndpoint && res.couchTokenUrl)
    return {
      channel: 'couch',
      endpoint: res.couchEndpoint,
      db: couch.db,
      tokenUrl: res.couchTokenUrl,
    };
  return { channel: 'git' };
}

/** Build the per-vault git remote URL from a resolved endpoint. Token is NEVER here. */
export function buildRepoUrl(gitEndpoint: string, vault: string): string {
  return `${gitEndpoint.replace(/\/+$/, '')}/${vault}.git`;
}

export class HostResolver {
  private cached?: { value: SyncResolution; expiresAt: number };

  constructor(
    private readonly bootstrapHost: string, // e.g. https://sync.agentage.io
    private readonly fetchJson: FetchJson,
    private readonly now: Clock
  ) {}

  async resolve(token: string): Promise<SyncResolution> {
    if (this.cached && this.now() < this.cached.expiresAt) return this.cached.value;
    const url = `${this.bootstrapHost.replace(/\/+$/, '')}${WELL_KNOWN}`;
    const res = await this.fetchJson(url, token);
    if (res.status === 401) throw new Error('resolution: unauthorized');
    if (res.status < 200 || res.status >= 300) throw new Error(`resolution: HTTP ${res.status}`);
    const value = parseResolution(res.json);
    this.cached = { value, expiresAt: this.now() + value.ttl * 1000 };
    return value;
  }

  /** Drop the cache (call on a 308/421 move so the next resolve re-fetches). */
  invalidate(): void {
    this.cached = undefined;
  }
}
