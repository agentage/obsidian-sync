// Mints + caches the per-(user,memory) CouchDB JWT from the auth service. The auth service
// is the sole minter (owns COUCH_JWT_SECRET); the plugin POSTs its OAuth bearer to the
// resolved `couch_token_url` and gets back a short-lived JWT it presents to CouchDB as
// `Bearer <jwt>`. Sync never signs a credential. DI'd post + bearer + clock so it
// unit-tests in Node without Obsidian or a live server.

export interface CouchTokenData {
  jwt: string;
  db: string;
  sub: string;
  expSec: number;
}

// requestUrl-backed POST in main; a mock in tests. Returns the parsed JSON body + status.
export type CouchTokenPost = (
  url: string,
  body: string,
  bearer: string
) => Promise<{ status: number; json: unknown }>;

export type GetBearer = () => Promise<string | null>;
export type Clock = () => number;

// Re-mint this far before the JWT's stated expiry so an in-flight couch request never
// carries a token that expires mid-request.
const SKEW_MS = 60_000;

// Server envelope: { success, data: { jwt, db, sub, expSec } } (auth /account/couch-token).
export function parseCouchToken(raw: unknown): CouchTokenData {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object') throw new Error('couch-token: missing data');
  const d = data as Record<string, unknown>;
  if (typeof d.jwt !== 'string' || !d.jwt) throw new Error('couch-token: missing jwt');
  const db = typeof d.db === 'string' ? d.db : '';
  const sub = typeof d.sub === 'string' ? d.sub : '';
  const expSec = typeof d.expSec === 'number' && d.expSec > 0 ? d.expSec : 3600;
  return { jwt: d.jwt, db, sub, expSec };
}

export class CouchTokenClient {
  private cached?: { jwt: string; expiresAt: number };

  constructor(
    private readonly tokenUrl: string,
    private readonly memory: string,
    private readonly post: CouchTokenPost,
    private readonly getBearer: GetBearer,
    private readonly now: Clock
  ) {}

  /** A valid couch JWT, minting a fresh one when the cache is empty or within ~60s of expiry. */
  async token(): Promise<string> {
    const c = this.cached;
    if (c && this.now() < c.expiresAt - SKEW_MS) return c.jwt;
    return this.mint();
  }

  /** Drop the cache so the next token() re-mints (call on a 401 from CouchDB). */
  invalidate(): void {
    this.cached = undefined;
  }

  private async mint(): Promise<string> {
    const bearer = await this.getBearer();
    if (!bearer) throw new Error('couch-token: not signed in');
    const res = await this.post(this.tokenUrl, JSON.stringify({ memory: this.memory }), bearer);
    // 401 = the bearer was genuinely rejected (expired/revoked); web#399 landed OAuth-bearer
    // acceptance on /account/couch-token, so this is no longer a known server gap.
    if (res.status === 401) throw new Error('couch-token: unauthorized (OAuth bearer rejected)');
    if (res.status < 200 || res.status >= 300) throw new Error(`couch-token: HTTP ${res.status}`);
    const data = parseCouchToken(res.json);
    this.cached = { jwt: data.jwt, expiresAt: this.now() + data.expSec * 1000 };
    return data.jwt;
  }
}
