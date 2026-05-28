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

/** Resolve once `predicate()` returns true; throw if the deadline elapses. */
export async function pollUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 250, label = 'condition' }: {
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
