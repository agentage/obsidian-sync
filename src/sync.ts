/**
 * Direct CouchDB writes for the v1 one-shot "push current note" flow.
 *
 * Pure (fetch is injected) so the module can be unit-tested without the
 * Obsidian runtime. The Obsidian-side adapter in main.ts wraps `requestUrl`
 * to satisfy the `FetchLike` shape.
 */

export const DB_NAME = 'agentage-memory';

export interface SyncCreds {
  serverUrl: string;
  username: string;
  password: string;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResult {
  status: number;
  text: string;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResult>;

function basicAuth(username: string, password: string): string {
  return 'Basic ' + btoa(`${username}:${password}`);
}

function dbBase(creds: SyncCreds): string {
  return `${creds.serverUrl.replace(/\/+$/, '')}/${DB_NAME}`;
}

function authHeaders(creds: SyncCreds): Record<string, string> {
  return { Authorization: basicAuth(creds.username, creds.password) };
}

/** Idempotent: create the database if it doesn't exist. */
export async function ensureDatabase(creds: SyncCreds, fetch: FetchLike): Promise<void> {
  const url = dbBase(creds);
  const headers = authHeaders(creds);
  const head = await fetch(url, { method: 'HEAD', headers });
  if (head.status === 200) return;
  if (head.status === 401 || head.status === 403) {
    throw new Error(`auth failed (HTTP ${head.status})`);
  }
  if (head.status !== 404) {
    throw new Error(`unexpected HEAD ${url}: HTTP ${head.status}`);
  }
  const put = await fetch(url, { method: 'PUT', headers });
  if (put.status !== 201 && put.status !== 412) {
    throw new Error(`failed to create db: HTTP ${put.status} ${put.text}`);
  }
}

/**
 * Write a single vault note to CouchDB as one whole document.
 * `_id` = vault path; body = `{ content, mtime }`. Handles `_rev` on update.
 */
export async function pushNote(
  creds: SyncCreds,
  vaultPath: string,
  content: string,
  mtime: number,
  fetch: FetchLike
): Promise<{ id: string; rev: string }> {
  const id = vaultPath;
  const url = `${dbBase(creds)}/${encodeURIComponent(id)}`;
  const headers = { ...authHeaders(creds), 'Content-Type': 'application/json' };

  // Look up current _rev when the doc already exists.
  const get = await fetch(url, { method: 'GET', headers });
  let rev: string | undefined;
  if (get.status === 200) {
    rev = (JSON.parse(get.text) as { _rev?: string })._rev;
  } else if (get.status !== 404) {
    throw new Error(`unexpected GET ${url}: HTTP ${get.status}`);
  }

  const doc = { _id: id, content, mtime, ...(rev ? { _rev: rev } : {}) };
  const put = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify(doc),
  });
  if (put.status !== 201 && put.status !== 202) {
    throw new Error(`push failed: HTTP ${put.status} ${put.text}`);
  }
  const parsed = JSON.parse(put.text) as { id: string; rev: string };
  return { id: parsed.id, rev: parsed.rev };
}
