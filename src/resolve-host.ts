// Host resolution (R7): the plugin knows one bootstrap host and resolves its
// per-user/per-region git endpoint from GET /.well-known/agentage-sync, caching it
// for the response ttl (default 1h). fetch + clock are INJECTED so it unit-tests in
// Node without Obsidian or a live server.

export interface SyncResolution {
  gitEndpoint: string;
  region: string;
  vaults: string[];
  ttl: number;
}

export type FetchJson = (url: string, token: string) => Promise<{ status: number; json: unknown }>;
export type Clock = () => number;

const WELL_KNOWN = '/.well-known/agentage-sync';

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
  return { gitEndpoint, region, vaults, ttl };
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
