/** Minimal CouchDB test helpers — Node-side, no Obsidian dependency. */

const URL = process.env.COUCHDB_URL ?? 'http://localhost:5984';
const USER = process.env.COUCHDB_USER ?? 'admin';
const PASS = process.env.COUCHDB_PASSWORD ?? 'agentage';
export const DB = process.env.COUCHDB_DB ?? 'agentage-memory-e2e';

const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

async function couch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${URL}${path}`, {
    ...init,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

/** Reset the test DB so each test starts on a known empty state. */
export async function resetTestDb(): Promise<void> {
  await couch(`/${DB}`, { method: 'DELETE' });
  const put = await couch(`/${DB}`, { method: 'PUT' });
  if (put.status !== 201 && put.status !== 412) {
    throw new Error(`couldn't create ${DB}: HTTP ${put.status} ${await put.text()}`);
  }
}

/** HTTP status for a doc lookup (200 = exists, 404 = missing / deleted). */
export async function docStatus(id: string): Promise<number> {
  const res = await couch(`/${DB}/${encodeURIComponent(id)}`);
  return res.status;
}

interface CouchDoc {
  _id: string;
  _rev?: string;
  content?: string;
  mtime?: number;
}

/** Fetch a doc, or null when it's missing / deleted. */
export async function getDoc(id: string): Promise<CouchDoc | null> {
  const res = await couch(`/${DB}/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getDoc ${id}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as CouchDoc;
}

/**
 * Upsert a note doc straight into CouchDB (the cloud writer an AI client would
 * be). Fetches the current `_rev` first so a second call overwrites instead of
 * 409-ing. Returns the new revision.
 */
export async function putDoc(id: string, content: string): Promise<string> {
  const existing = await getDoc(id);
  const body: CouchDoc = {
    _id: id,
    content,
    mtime: Date.now(),
    ...(existing?._rev ? { _rev: existing._rev } : {}),
  };
  const res = await couch(`/${DB}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`putDoc ${id}: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { rev: string }).rev;
}

/** Delete a doc in CouchDB (a tombstone the plugin should route to trash). */
export async function deleteDoc(id: string): Promise<void> {
  const existing = await getDoc(id);
  if (!existing?._rev) return;
  const res = await couch(`/${DB}/${encodeURIComponent(id)}?rev=${existing._rev}`, {
    method: 'DELETE',
  });
  if (res.status !== 200) {
    throw new Error(`deleteDoc ${id}: HTTP ${res.status} ${await res.text()}`);
  }
}

/** Resolve once `predicate()` returns true; throw if the deadline elapses. */
export async function pollUntil(
  predicate: () => Promise<boolean>,
  {
    timeoutMs = 20_000,
    intervalMs = 250,
    label = 'condition',
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
  } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms waiting for: ${label}`);
}
