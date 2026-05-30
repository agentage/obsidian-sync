/**
 * Local PouchDB store (IndexedDB-backed). One doc per note: `_id` = vault path,
 * body = `{ content, mtime }`. These ops run against the in-process replica and
 * are unit-tested with `pouchdb-adapter-memory`; the remote/HTTP replication
 * layer lives in `replication.ts`.
 */
import PouchDB from 'pouchdb-browser';

export const LOCAL_DB_NAME = 'agentage-memory-local';

export interface MemoryDoc {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
  content?: string;
  mtime?: number;
}

/** The local replica's concrete PouchDB type. */
export type LocalDb = PouchDB.Database<MemoryDoc>;

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
    try {
      await db.remove(id, rev);
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status !== 404 && status !== 409) throw err;
    }
  }
  return { deleted: false, content: winner.content ?? '', losers };
}
