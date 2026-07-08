import type { FileDoc, LeafDoc } from '../../src/couch/couch-doc';

// An in-memory CouchDB matching the exact wire contract src/couch/couch-sync.ts speaks:
//   - docs keyed by id: file docs `f:<path>` + leaf docs `h:<hash>`, each with a _rev
//   - an ordered changes log with a monotonic integer seq (stringified as last_seq)
//   - GET /<id>            -> doc (200) or 404
//   - POST /_bulk_docs     -> [] (leaves accepted) or [{id,error}] (scripted leaf failure)
//   - PUT /f:<path>        -> upsert + bump _rev + append a change; 409 on a stale _rev
//   - DELETE /f:<path>?rev -> 409 if stale, else tombstone + a deleted change
//   - GET /_changes?since=&limit= -> a page slice + last_seq
// Fault knobs (failNext / unauthorizeUntilRemint / dropLeaf / injectRemoteChange) are wired
// now for the PR-2 scenario fan-out, exercised by the smoke only through the happy path.

type StoredDoc = (FileDoc | LeafDoc) & { _rev: string; _deleted?: boolean };
interface ChangeRow {
  seq: number;
  id: string;
  rev: string;
  deleted: boolean;
}

export interface CouchReply {
  status: number;
  json: unknown;
}

const rev = (n: number, tag: string): string => `${n}-${tag.slice(0, 8).padStart(8, '0')}`;
const revNum = (r: string): number => Number(r.split('-')[0]) || 0;

export class FakeCouch {
  private docs = new Map<string, StoredDoc>();
  private changes: ChangeRow[] = [];
  private seq = 0;
  private failStatus?: number;
  private unauthorizeOnce = false;
  private droppedLeaves = new Set<string>();
  private failLeaf?: { id: string; error: string };

  constructor(readonly db: string) {}

  // -- fault knobs (PR-2) -----------------------------------------------------
  /** The next request (any) returns this status once, then normal service resumes. */
  failNext(status: number): void {
    this.failStatus = status;
  }
  /** Return 401 once (as an expired couch JWT would), forcing the client to re-mint + retry. */
  unauthorizeUntilRemint(): void {
    this.unauthorizeOnce = true;
  }
  /** Make a leaf GET 404 even though the file doc references it (truncation-guard test). */
  dropLeaf(id: string): void {
    this.droppedLeaves.add(id);
  }
  /** Script the next _bulk_docs to report a per-leaf failure for `id`. */
  failLeafOnBulk(id: string, error = 'forbidden'): void {
    this.failLeaf = { id, error };
  }
  /** Seed a remote-origin change (as another device would) so a pull delivers it. */
  injectRemoteChange(path: string, body: string, leaves: LeafDoc[]): void {
    for (const l of leaves) this.docs.set(l._id, { ...l, _rev: l._rev || rev(1, l._id.slice(2)) });
    const id = `f:${path}`;
    const prev = this.docs.get(id);
    const n = prev ? revNum(prev._rev) + 1 : 1;
    const doc: StoredDoc = {
      _id: id,
      _rev: rev(n, path + body.length),
      type: 'file',
      path,
      size: body.length,
      leaves: leaves.map((l) => l._id),
    };
    this.docs.set(id, doc);
    this.append(id, doc._rev, false);
  }

  // -- assertion helpers ------------------------------------------------------
  fileDoc(path: string): FileDoc | undefined {
    const d = this.docs.get(`f:${path}`);
    return d && d._deleted !== true && (d as FileDoc).type === 'file' ? (d as FileDoc) : undefined;
  }
  hasLeaf(id: string): boolean {
    return this.docs.has(id);
  }
  filePaths(): string[] {
    return [...this.docs.values()]
      .filter((d) => (d as FileDoc).type === 'file' && !d._deleted)
      .map((d) => (d as FileDoc).path)
      .sort();
  }
  lastSeq(): number {
    return this.seq;
  }

  private append(id: string, r: string, deleted: boolean): void {
    // Latest-wins per id (CouchDB collapses superseded rows), so drop any prior row for this id.
    this.changes = this.changes.filter((c) => c.id !== id);
    this.changes.push({ seq: ++this.seq, id, rev: r, deleted });
  }

  // -- request dispatch -------------------------------------------------------
  /** Handle one couch request; `path` is everything after `<endpoint>/<db>`. */
  handle(method: string, path: string, body?: string): CouchReply {
    if (this.unauthorizeOnce) {
      this.unauthorizeOnce = false;
      return { status: 401, json: { error: 'unauthorized' } };
    }
    if (this.failStatus !== undefined) {
      const status = this.failStatus;
      this.failStatus = undefined;
      return { status, json: { error: 'scripted failure' } };
    }
    const [rawId, query = ''] = path.replace(/^\//, '').split('?');
    const id = decodeURIComponent(rawId);
    if (id === '_bulk_docs') return this.bulkDocs(body);
    if (id === '_changes') return this.changesFeed(query);
    if (method === 'GET') return this.getDoc(id);
    if (method === 'PUT') return this.putDoc(id, body);
    if (method === 'DELETE') return this.deleteDoc(id, query);
    return { status: 405, json: { error: 'method not allowed' } };
  }

  private getDoc(id: string): CouchReply {
    if (id.startsWith('h:') && this.droppedLeaves.has(id)) return { status: 404, json: {} };
    const d = this.docs.get(id);
    if (!d || d._deleted) return { status: 404, json: { error: 'not_found' } };
    return { status: 200, json: d };
  }

  private bulkDocs(body?: string): CouchReply {
    const parsed = JSON.parse(body ?? '{}') as { docs?: LeafDoc[] };
    for (const leaf of parsed.docs ?? []) {
      if (this.failLeaf && this.failLeaf.id === leaf._id) {
        const err = this.failLeaf;
        this.failLeaf = undefined;
        return { status: 200, json: [{ id: err.id, error: err.error }] };
      }
      if (!this.docs.has(leaf._id))
        this.docs.set(leaf._id, { ...leaf, _rev: leaf._rev || rev(1, leaf._id.slice(2)) });
    }
    return { status: 200, json: [] }; // new_edits:false -> no per-doc rows on success
  }

  private putDoc(id: string, body?: string): CouchReply {
    const put = JSON.parse(body ?? '{}') as FileDoc;
    const cur = this.docs.get(id);
    if (cur && !cur._deleted && cur._rev !== put._rev)
      return { status: 409, json: { error: 'conflict' } };
    const n = cur ? revNum(cur._rev) + 1 : 1;
    const stored: StoredDoc = { ...put, _rev: rev(n, id + (put.leaves?.join('') ?? '')) };
    this.docs.set(id, stored);
    this.append(id, stored._rev, false);
    return { status: 201, json: { ok: true, id, rev: stored._rev } };
  }

  private deleteDoc(id: string, query: string): CouchReply {
    const revParam = new URLSearchParams(query).get('rev');
    const cur = this.docs.get(id);
    if (!cur || cur._deleted) return { status: 404, json: { error: 'not_found' } };
    if (revParam !== cur._rev) return { status: 409, json: { error: 'conflict' } };
    const n = revNum(cur._rev) + 1;
    const tomb: StoredDoc = { ...cur, _rev: rev(n, id + 'del'), _deleted: true };
    this.docs.set(id, tomb);
    this.append(id, tomb._rev, true);
    return { status: 200, json: { ok: true, id, rev: tomb._rev } };
  }

  private changesFeed(query: string): CouchReply {
    const q = new URLSearchParams(query);
    const since = Number(q.get('since') ?? '0') || 0;
    const limit = Number(q.get('limit') ?? '200') || 200;
    const rows = this.changes.filter((c) => c.seq > since).sort((a, b) => a.seq - b.seq);
    const page = rows.slice(0, limit);
    const results = page.map((c) => {
      const doc = this.docs.get(c.id) as FileDoc | undefined;
      return c.deleted
        ? { id: c.id, deleted: true, changes: [{ rev: c.rev }] }
        : { id: c.id, changes: [{ rev: c.rev }], doc };
    });
    const last = page.length ? page[page.length - 1].seq : since;
    return { status: 200, json: { results, last_seq: String(last) } };
  }
}
