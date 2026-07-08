// In-memory Better Auth AS + management API: OAuth 2.1 discovery / DCR / token / refresh /
// revoke, the couch-token minter, and GET/POST /api/memories. Contracts mirror the real
// wire the plugin's src/auth/* + src/couch/couch-token + main.ts:listVaults speak.

export interface FakeMemory {
  name: string;
  entries: number;
  folderCount: number;
  updated: string | null;
}

export interface AuthReply {
  status: number;
  json: unknown;
}

interface IssuedTokens {
  access: string;
  refresh: string;
  clientId: string;
}

export class FakeAuthServer {
  private clients = new Set<string>();
  private codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  private tokens = new Map<string, IssuedTokens>(); // accessToken -> issued
  private refreshIndex = new Map<string, string>(); // refreshToken -> accessToken
  private clientSeq = 0;
  private tokenSeq = 0;
  readonly memories: FakeMemory[];
  readonly couchDb: string;
  private failNextStatus?: number;
  private failNextMgmtStatus?: number;

  constructor(opts: { memories?: FakeMemory[]; couchDb?: string } = {}) {
    this.memories = opts.memories ?? [];
    this.couchDb = opts.couchDb ?? 'mem_default';
  }

  failNext(status: number): void {
    this.failNextStatus = status;
  }

  /** The next /api/memories GET or POST returns this status once (server-gap simulation). */
  failNextManagement(status: number): void {
    this.failNextMgmtStatus = status;
  }

  private takeMgmtFailure(): AuthReply | null {
    if (this.failNextMgmtStatus === undefined) return null;
    const status = this.failNextMgmtStatus;
    this.failNextMgmtStatus = undefined;
    return { status, json: { error: { message: 'management endpoint unavailable' } } };
  }

  /** Is `access` a live (unrevoked) access token? Used by the api + couch-token guards. */
  isValidAccess(access: string): boolean {
    return this.tokens.has(access);
  }

  /** Drive the authorize step: mint a one-time code bound to the client + PKCE challenge. */
  authorize(params: {
    clientId: string;
    codeChallenge: string;
    state: string;
    redirectUri: string;
  }): { code: string; state: string } {
    if (!this.clients.has(params.clientId)) throw new Error('authorize: unknown client');
    const code = `code-${++this.tokenSeq}`;
    this.codes.set(code, {
      clientId: params.clientId,
      challenge: params.codeChallenge,
      redirectUri: params.redirectUri,
    });
    return { code, state: params.state };
  }

  private issue(clientId: string): AuthReply {
    const access = `at-${++this.tokenSeq}`;
    const refresh = `rt-${this.tokenSeq}`;
    this.tokens.set(access, { access, refresh, clientId });
    this.refreshIndex.set(refresh, access);
    return {
      status: 200,
      json: { access_token: access, refresh_token: refresh, expires_in: 3600 },
    };
  }

  handle(method: string, url: string, body?: string): AuthReply {
    if (this.failNextStatus !== undefined) {
      const status = this.failNextStatus;
      this.failNextStatus = undefined;
      return { status, json: { error: 'scripted failure' } };
    }
    const { pathname } = new URL(url);
    if (pathname.endsWith('/.well-known/oauth-authorization-server')) return this.discovery(url);
    if (pathname.endsWith('/register')) return this.register();
    if (pathname.endsWith('/token')) return this.token(body);
    if (pathname.endsWith('/revoke')) return { status: 200, json: {} };
    if (pathname.endsWith('/account/couch-token')) return this.couchToken(body);
    return { status: 404, json: { error: 'not_found' } };
  }

  private discovery(url: string): AuthReply {
    const origin = new URL(url).origin;
    return {
      status: 200,
      json: {
        issuer: origin,
        authorization_endpoint: `${origin}/api/auth/mcp/authorize`,
        token_endpoint: `${origin}/api/auth/mcp/token`,
        registration_endpoint: `${origin}/api/auth/mcp/register`,
        revocation_endpoint: `${origin}/api/auth/mcp/revoke`,
      },
    };
  }

  private register(): AuthReply {
    const clientId = `client-${++this.clientSeq}`;
    this.clients.add(clientId);
    return { status: 201, json: { client_id: clientId } };
  }

  private token(body?: string): AuthReply {
    const p = new URLSearchParams(body ?? '');
    const grant = p.get('grant_type');
    if (grant === 'authorization_code') {
      const code = p.get('code') ?? '';
      const rec = this.codes.get(code);
      if (!rec) return { status: 400, json: { error: 'invalid_grant' } };
      this.codes.delete(code);
      return this.issue(rec.clientId);
    }
    if (grant === 'refresh_token') {
      const rt = p.get('refresh_token') ?? '';
      const priorAccess = this.refreshIndex.get(rt);
      if (!priorAccess) return { status: 400, json: { error: 'invalid_grant' } };
      const prior = this.tokens.get(priorAccess);
      this.refreshIndex.delete(rt);
      if (prior) this.tokens.delete(prior.access); // rotate: the old access token dies
      return this.issue(prior?.clientId ?? p.get('client_id') ?? 'client');
    }
    return { status: 400, json: { error: 'unsupported_grant_type' } };
  }

  private couchToken(body?: string): AuthReply {
    const memory = (JSON.parse(body ?? '{}') as { memory?: string }).memory ?? 'default';
    return {
      status: 200,
      json: {
        success: true,
        data: { jwt: `couch-jwt-${memory}`, db: this.couchDb, sub: `u/${memory}`, expSec: 3600 },
      },
    };
  }

  /** GET /api/memories -> { data:[{name,entries,folderCount,updated}] }. */
  listMemories(): AuthReply {
    return this.takeMgmtFailure() ?? { status: 200, json: { data: this.memories } };
  }

  /** POST /api/memories { name } -> 201 (adds an empty memory). */
  createMemory(body?: string): AuthReply {
    const failed = this.takeMgmtFailure();
    if (failed) return failed;
    const name = (JSON.parse(body ?? '{}') as { name?: string }).name ?? '';
    if (!name) return { status: 400, json: { error: { message: 'name required' } } };
    if (!this.memories.some((m) => m.name === name))
      this.memories.push({ name, entries: 0, folderCount: 0, updated: null });
    return { status: 201, json: { data: { name } } };
  }
}
