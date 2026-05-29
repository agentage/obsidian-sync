/**
 * Remote CouchDB replication layer. Everything here talks to the network over
 * PouchDB's HTTP adapter, so it needs a live CouchDB to exercise — it is
 * coverage-excluded and verified by the E2E suite, not unit tests. The local
 * store (testable) lives in `pouch.ts`.
 *
 * Architecture pins (see /home/vreshch/agentage-memory/research/obsidian-plugin/plan.md):
 *   - CORS is bypassed by giving PouchDB a `fetch` impl that wraps Obsidian's
 *     `requestUrl` (no CORS headers required on the CouchDB side at request time).
 */
import PouchDB from 'pouchdb-browser';
import { getLocalDb, upsertNote, type MemoryDoc } from './pouch';

export interface PushCreds {
  serverUrl: string;
  /** Remote CouchDB database name. */
  dbName: string;
}

/** Fetch impl that satisfies PouchDB's expected shape. */
export type PouchFetch = (url: string | URL | Request, opts?: RequestInit) => Promise<Response>;

function remoteUrl(creds: PushCreds): string {
  return `${creds.serverUrl.replace(/\/+$/, '')}/${creds.dbName}`;
}

/**
 * Construct a remote PouchDB pointing at the CouchDB database.
 *
 * Note: we intentionally do NOT use PouchDB's `auth: {username, password}`
 * constructor option. In PouchDB 7+ that option only propagates to direct
 * document operations — the live replication `_changes` feed bypasses it
 * and returns 401. Auth must be baked into `fetchImpl` (see
 * `obsidianFetchForPouch`), which fires on every request type.
 */
export function getRemoteDb(creds: PushCreds, fetchImpl: PouchFetch): PouchDB.Database<MemoryDoc> {
  return new PouchDB<MemoryDoc>(remoteUrl(creds), {
    fetch: fetchImpl,
  });
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

/** A normalised view of a PouchDB.Replication.SyncResult batch. */
export interface SyncChange {
  direction: 'push' | 'pull';
  docs: MemoryDoc[];
  docsWritten: number;
  docsRead: number;
}

export interface SyncCallbacks {
  onActive?: () => void;
  onPaused?: (err?: unknown) => void;
  onChange?: (info: SyncChange) => void;
  onError?: (err: unknown) => void;
}

/**
 * Start continuous **two-way** sync (local <-> remote) with retry.
 *
 * The change callback fires for each batch; `direction: 'pull'` carries docs
 * that just arrived from CouchDB and the caller should apply them to the
 * vault. `direction: 'push'` is informational — those docs were already
 * upserted locally by the vault watcher.
 */
export function startContinuousSync(
  creds: PushCreds,
  fetchImpl: PouchFetch,
  callbacks?: SyncCallbacks
): ReplicationHandle {
  const local = getLocalDb();
  const remote = getRemoteDb(creds, fetchImpl);
  const sync = PouchDB.sync(local, remote, {
    live: true,
    retry: true,
  });

  if (callbacks?.onActive) sync.on('active', callbacks.onActive);
  if (callbacks?.onPaused) sync.on('paused', callbacks.onPaused);
  if (callbacks?.onError) sync.on('error', callbacks.onError);
  if (callbacks?.onChange) {
    sync.on('change', (info) => {
      callbacks.onChange?.({
        direction: info.direction,
        docs: (info.change.docs ?? []) as MemoryDoc[],
        docsWritten: info.change.docs_written ?? 0,
        docsRead: info.change.docs_read ?? 0,
      });
    });
  }

  return {
    cancel: () => {
      sync.cancel();
    },
  };
}
