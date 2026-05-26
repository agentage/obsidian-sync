/**
 * PouchDB-backed sync layer. Maintains a single local PouchDB (IndexedDB) and
 * pushes notes to a remote CouchDB via one-shot replication. Two-way live
 * replication + the vault watcher land in follow-up PRs.
 *
 * Architecture pins (see /home/vreshch/agentage-memory/research/obsidian-plugin/plan.md):
 *   - one-doc-per-note: `_id` = vault path, body = `{ content, mtime }`.
 *   - CORS is bypassed by giving PouchDB a `fetch` impl that wraps Obsidian's
 *     `requestUrl` (no CORS headers required on the CouchDB side at request time).
 */
import PouchDB from 'pouchdb-browser';

export const DB_NAME = 'agentage-memory';
export const LOCAL_DB_NAME = 'agentage-memory-local';

export interface PushCreds {
  serverUrl: string;
  username: string;
  password: string;
}

export interface MemoryDoc {
  _id: string;
  _rev?: string;
  content: string;
  mtime: number;
}

/** Fetch impl that satisfies PouchDB's expected shape. */
export type PouchFetch = (url: string | URL | Request, opts?: RequestInit) => Promise<Response>;

let localDbInstance: PouchDB.Database<MemoryDoc> | null = null;

/** Singleton local PouchDB (IndexedDB-backed in the browser). */
export function getLocalDb(): PouchDB.Database<MemoryDoc> {
  if (!localDbInstance) {
    localDbInstance = new PouchDB<MemoryDoc>(LOCAL_DB_NAME);
  }
  return localDbInstance;
}

/** Reset the cached local DB (for tests + sign-out flows). */
export async function destroyLocalDb(): Promise<void> {
  if (localDbInstance) {
    await localDbInstance.destroy();
    localDbInstance = null;
  }
}

function remoteUrl(creds: PushCreds): string {
  return `${creds.serverUrl.replace(/\/+$/, '')}/${DB_NAME}`;
}

/**
 * Construct a remote PouchDB pointing at the CouchDB database.
 *
 * Note: we intentionally do NOT use PouchDB's `auth: {username, password}`
 * constructor option. In PouchDB 7+ that option only propagates to direct
 * document operations — the live replication `_changes` feed bypasses it
 * and returns 401. Auth must be baked into `fetchImpl` (see
 * `obsidianFetchForPouch` in main.ts), which fires on every request type.
 */
export function getRemoteDb(creds: PushCreds, fetchImpl: PouchFetch): PouchDB.Database<MemoryDoc> {
  return new PouchDB<MemoryDoc>(remoteUrl(creds), {
    fetch: fetchImpl,
  });
}

/** Upsert a vault note into the given PouchDB. Returns the new revision. */
export async function upsertNote(
  db: PouchDB.Database<MemoryDoc>,
  vaultPath: string,
  content: string,
  mtime: number
): Promise<{ id: string; rev: string }> {
  let rev: string | undefined;
  try {
    const existing = await db.get(vaultPath);
    rev = existing._rev;
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 404) throw err;
  }
  const result = await db.put({
    _id: vaultPath,
    content,
    mtime,
    ...(rev ? { _rev: rev } : {}),
  });
  return { id: result.id, rev: result.rev };
}

/**
 * Push a vault note to CouchDB via the local PouchDB.
 * 1. Upsert to the local DB.
 * 2. One-shot replicate that single doc to the remote (creates the target DB
 *    on first push thanks to `create_target: true`).
 */
export async function pushNoteViaPouch(
  creds: PushCreds,
  vaultPath: string,
  content: string,
  mtime: number,
  fetchImpl: PouchFetch
): Promise<{ id: string; rev: string }> {
  const local = getLocalDb();
  const remote = getRemoteDb(creds, fetchImpl);

  const result = await upsertNote(local, vaultPath, content, mtime);

  // PouchDB's remote constructor (above) already PUTs the target DB on first
  // use (skip_setup defaults to false), so we don't need `create_target` here
  // — which @types/pouchdb-browser 6.x doesn't expose anyway.
  await PouchDB.replicate(local, remote, {
    doc_ids: [vaultPath],
  });

  return result;
}

export interface ReplicationHandle {
  cancel(): void;
}

export interface ReplicationCallbacks {
  onActive?: () => void;
  onPaused?: (err?: unknown) => void;
  onChange?: (info: unknown) => void;
  onError?: (err: unknown) => void;
}

/**
 * Start continuous one-way replication local -> remote with retry.
 * Returns a handle whose `cancel()` stops the replication.
 *
 * Two-way (remote -> local) + applying remote changes to the vault lands in
 * the next PR; for now we only push edits upstream so the echo-loop risk
 * doesn't exist yet.
 */
export function startContinuousReplication(
  creds: PushCreds,
  fetchImpl: PouchFetch,
  callbacks?: ReplicationCallbacks
): ReplicationHandle {
  const local = getLocalDb();
  const remote = getRemoteDb(creds, fetchImpl);
  const rep = PouchDB.replicate(local, remote, {
    live: true,
    retry: true,
  });
  if (callbacks?.onActive) rep.on('active', callbacks.onActive);
  if (callbacks?.onPaused) rep.on('paused', callbacks.onPaused);
  if (callbacks?.onChange) rep.on('change', callbacks.onChange);
  if (callbacks?.onError) rep.on('error', callbacks.onError);
  return {
    cancel: () => {
      rep.cancel();
    },
  };
}
