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

export const LOCAL_DB_NAME = 'agentage-memory-local';

export interface PushCreds {
  serverUrl: string;
  /** Remote CouchDB database name. */
  dbName: string;
}

export interface MemoryDoc {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
  content?: string;
  mtime?: number;
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

/** All notes currently in a PouchDB, keyed by `_id` (vault path). Used by the
 * seed pass to diff the vault against the replica without N round-trips. */
export async function getAllLocalDocs(
  db: PouchDB.Database<MemoryDoc>
): Promise<Map<string, MemoryDoc>> {
  const result = await db.allDocs({ include_docs: true });
  const map = new Map<string, MemoryDoc>();
  for (const row of result.rows) {
    if (row.doc) map.set(row.id, row.doc);
  }
  return map;
}

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
 * Soft-delete a note in PouchDB. Creates a tombstone that replicates
 * upstream so other clients can route the deletion to system trash. Returns
 * the tombstone revision, or `null` when the doc didn't exist (no-op).
 */
export async function removeNote(
  db: PouchDB.Database<MemoryDoc>,
  vaultPath: string
): Promise<{ id: string; rev: string } | null> {
  try {
    const doc = await db.get(vaultPath);
    const result = await db.remove(doc._id, doc._rev as string);
    return { id: result.id, rev: result.rev };
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 404) return null;
    throw err;
  }
}

/** A losing revision's identity + body, surfaced so the caller can preserve it. */
export interface ConflictLoser {
  rev: string;
  content: string;
}

/** The authoritative state of a doc after PouchDB picked a conflict winner. */
export interface DocResolution {
  /** True when the winning revision is a tombstone (the note is deleted). */
  deleted: boolean;
  /** The winning revision's body (empty when deleted). */
  content: string;
  /** Losing revisions, already removed from the local replica. */
  losers: ConflictLoser[];
}

/**
 * Resolve a doc to what should actually be in the vault. The replication
 * `change` feed reports whichever revision just arrived, which under a
 * conflict can be the *loser* — so we never trust that body. Instead we read
 * the local replica's chosen winner here, and for each losing branch we grab
 * its body (for a sidecar) then remove that leaf — clearing the conflict and
 * replicating the resolution so other clients don't each re-surface it.
 *
 * Note: a delete-vs-edit conflict where the delete wins surfaces as `deleted`
 * with no losers — the edit branch is not preserved. Rare; deferred for v1.
 */
export async function resolveConflictedDoc(
  db: PouchDB.Database<MemoryDoc>,
  id: string
): Promise<DocResolution> {
  let winner: MemoryDoc & { _conflicts?: string[] };
  try {
    winner = await db.get(id, { conflicts: true });
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 404) {
      return { deleted: true, content: '', losers: [] };
    }
    throw err;
  }
  const losers: ConflictLoser[] = [];
  for (const rev of winner._conflicts ?? []) {
    const doc = await db.get(id, { rev });
    losers.push({ rev, content: doc.content ?? '' });
    // Tolerate a concurrent resolution already having removed this leaf.
    await db.remove(id, rev).catch((err) => {
      const status = (err as { status?: number } | null)?.status;
      if (status !== 404 && status !== 409) throw err;
    });
  }
  return { deleted: false, content: winner.content ?? '', losers };
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
