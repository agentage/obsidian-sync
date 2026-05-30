/**
 * Sync bootstrap: trade a valid account access token for a short-lived,
 * per-tenant CouchDB sync target (`{syncUrl, dbName, token, expiresAt}`). The
 * HTTP transport is injected as an `HttpPost` (shared with `oauth.ts`), so the
 * request shaping, response parsing, and expiry logic are unit-tested with a
 * fake — no network, no Obsidian. The Obsidian-backed transport (`requestUrl`)
 * is wired in `main.ts`.
 *
 * The plugin never stores a CouchDB password: replication rides this derived
 * bearer token, refreshed on expiry. The backend endpoint that mints it is
 * `POST /api/sync/bootstrap` (verifies the account token, derives the cap).
 */
import type { HttpPost } from './oauth';

export interface SyncBootstrap {
  /** CouchDB host to replicate against (per-tenant, e.g. https://sync.agentage.io). */
  syncUrl: string;
  /** Per-tenant database name. */
  dbName: string;
  /** Short-lived CouchDB bearer token. */
  token: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
}

/** The bootstrap endpoint for an API origin (e.g. https://sync.agentage.io). */
export function bootstrapUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}/api/sync/bootstrap`;
}

/** Map a `/api/sync/bootstrap` response body to a `SyncBootstrap`; throws if malformed. */
export function bootstrapFromResponse(json: unknown, nowMs: number): SyncBootstrap {
  const body = (json ?? {}) as Record<string, unknown>;
  const syncUrl = typeof body.syncUrl === 'string' ? body.syncUrl : '';
  const dbName = typeof body.dbName === 'string' ? body.dbName : '';
  const token = typeof body.token === 'string' ? body.token : '';
  if (!syncUrl || !dbName || !token) {
    throw new Error('Bootstrap response missing syncUrl/dbName/token');
  }
  // Accept either an absolute `expiresAt` (ms) or a relative `expiresIn` (s).
  const expiresAt =
    typeof body.expiresAt === 'number'
      ? body.expiresAt
      : nowMs + (typeof body.expiresIn === 'number' ? body.expiresIn : 3600) * 1000;
  return { syncUrl, dbName, token, expiresAt };
}

/** True when the bootstrap is expired or within `skewMs` of expiring. */
export function isBootstrapExpired(b: SyncBootstrap, nowMs: number, skewMs = 60_000): boolean {
  return nowMs + skewMs >= b.expiresAt;
}

/**
 * Exchange an account access token for a sync target. `apiBase` is the API
 * origin (the auth host's origin); `accessToken` is the current valid token
 * from the auth flow.
 */
export async function requestSyncBootstrap(
  post: HttpPost,
  apiBase: string,
  accessToken: string,
  nowMs: number
): Promise<SyncBootstrap> {
  const res = await post(bootstrapUrl(apiBase), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (res.status < 200 || res.status >= 300) {
    const detail =
      (res.json as { error?: string; message?: string } | null)?.error ??
      (res.json as { message?: string } | null)?.message ??
      `HTTP ${res.status}`;
    throw new Error(`Sync bootstrap failed: ${detail}`);
  }
  return bootstrapFromResponse(res.json, nowMs);
}
