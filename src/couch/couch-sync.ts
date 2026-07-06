import { requestUrl, TFile, type Vault } from 'obsidian';
import {
  contentRev,
  encodeFile,
  fileId,
  leafIdsOf,
  pathOf,
  type FileDoc,
  type LeafDoc,
} from './couch-doc';
import type { CouchState } from './couch-state';

// CouchDB sync channel (thin client, the onepager's "thin client" option) - now THE account
// channel for couch-flagged memories. Replicates the vault's markdown to a per-memory CouchDB
// using the SAME content-addressed model the server bridge expects (leaf docs + a file doc);
// the bridge then commits every couch edit to git. Uses Obsidian's requestUrl (no CORS, no
// PouchDB bundle) + Web Crypto (mobile-safe, no node builtins). Echo-safe: a push/pull whose
// content already matches is skipped, so the vault<->couch<->git loop converges.

const DEFAULT_PAGE = 200; // _changes page size so a big feed never lands in one response
const SUPPRESS_MS = 200; // vault 'modify' fires async after our write; hold the echo guard past it
const ok2xx = (status: number): boolean => status >= 200 && status < 300;

export interface CouchSyncConfig {
  endpoint: string; // discovered couch host, e.g. https://couch.<fqdn>
  db: string; // discovered per-memory db name (mem_<hash>)
  pageLimit?: number; // _changes limit; defaults to DEFAULT_PAGE
}

// Mints/caches the couch JWT (CouchTokenClient.token); the header is always "Bearer <jwt>".
export type CouchAuthorize = () => Promise<string>;

export class CouchSync {
  private pulling = false;
  private suppress = new Set<string>(); // paths being written by a pull (skip their push)

  constructor(
    private vault: Vault,
    private cfg: CouchSyncConfig,
    private authorize: CouchAuthorize, // supplies a valid couch JWT (see CouchTokenClient)
    private onUnauthorized: () => void, // drop the token cache so a 401 retry re-mints
    private state: CouchState, // persisted cursor + push-rev cache + pending pushes
    private log: (msg: string) => void = () => {}
  ) {}

  private url(p: string): string {
    return `${this.cfg.endpoint.replace(/\/+$/, '')}/${this.cfg.db}${p}`;
  }
  private async req(
    p: string,
    init: { method?: string; body?: string } = {}
  ): Promise<{ status: number; json: unknown }> {
    const send = async (): Promise<{ status: number; json: unknown }> => {
      const jwt = await this.authorize();
      const r = await requestUrl({
        url: this.url(p),
        method: init.method ?? 'GET',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: init.body,
        throw: false,
      });
      let json: unknown = null;
      try {
        json = r.json;
      } catch {
        /* non-JSON */
      }
      return { status: r.status, json };
    };
    const out = await send();
    if (out.status !== 401) return out;
    this.onUnauthorized(); // JWT expired/rejected -> re-mint and retry once
    return send();
  }

  private async getDoc(id: string, rev?: string): Promise<(FileDoc & Partial<LeafDoc>) | null> {
    const r = await this.req(
      `/${encodeURIComponent(id)}${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`
    );
    return r.status === 200 ? (r.json as FileDoc & Partial<LeafDoc>) : null;
  }
  // Mirror the server's decodeFile: a missing leaf THROWS, never substitutes an empty chunk
  // (which would truncate the note). The caller aborts the pull round and keeps the cursor.
  private async reassemble(fdoc: FileDoc): Promise<string> {
    const parts: string[] = [];
    for (const id of fdoc.leaves) {
      const leaf = await this.getDoc(id);
      if (!leaf || typeof leaf.data !== 'string')
        throw new Error(`couch pull: missing leaf ${id} for ${fdoc.path}`);
      parts.push(leaf.data);
    }
    return parts.join('');
  }

  // -- push: vault -> couch --------------------------------------------------
  async pushFile(path: string): Promise<void> {
    if (this.suppress.has(path)) return; // we are mid-pull-writing this file
    const af = this.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile) || af.extension !== 'md') return;
    const body = await this.vault.read(af);
    const { leaves, fileDoc } = await encodeFile(path, body);
    const rev = contentRev(fileDoc);
    if (this.state.revFor(path) === rev) return; // this exact content is already pushed
    const cur = await this.getDoc(fileDoc._id);
    if (cur && !cur._deleted && JSON.stringify(cur.leaves) === JSON.stringify(fileDoc.leaves)) {
      await this.state.setRev(path, rev); // remote already converged; cache so we skip next time
      return;
    }
    const bulk = await this.req('/_bulk_docs', {
      method: 'POST',
      body: JSON.stringify({ new_edits: false, docs: leaves }),
    });
    if (!ok2xx(bulk.status)) throw new Error(`couch push leaves ${bulk.status} for ${path}`);
    // new_edits:false lists an entry ONLY for a leaf that genuinely failed to write, so any
    // reported error means the file doc would reference a missing leaf - throw, caller re-queues.
    const leafErr = (Array.isArray(bulk.json) ? bulk.json : []).find(
      (e): e is { id?: string; error: string } =>
        !!e && typeof e === 'object' && typeof (e as { error?: unknown }).error === 'string'
    );
    if (leafErr)
      throw new Error(`couch push leaf ${leafErr.error} (${leafErr.id ?? '?'}) for ${path}`);
    const put: FileDoc = { ...fileDoc };
    if (cur && cur._rev) put._rev = cur._rev; // normal update so this device's edit wins
    const r = await this.req(`/${encodeURIComponent(put._id)}`, {
      method: 'PUT',
      body: JSON.stringify(put),
    });
    // Cache the pushed rev only after couch accepted it, so a rejected push stays retryable.
    if (!ok2xx(r.status)) throw new Error(`couch push ${r.status} for ${path}`);
    await this.state.setRev(path, rev);
    this.log(`push ${path} -> ${r.status}`);
  }

  // Live push (sync-on-save): a failure queues the path so the next tick retries it, and a
  // success clears any prior queue entry. Never throws (the vault event handler is void).
  async pushFileLive(path: string): Promise<void> {
    await this.state.dequeueDelete(path); // latest intent is a write - cancel any queued delete
    try {
      await this.pushFile(path);
      await this.state.dequeue(path);
    } catch (e) {
      await this.state.enqueue(path);
      this.log(`push ${path} failed, queued: ${(e as Error).message}`);
    }
  }

  // Live delete: a failed DELETE (409 stale rev / 401 / 5xx) queues the path so the next tick
  // retries it - never swallowed (a swallowed delete lets pullOnce resurrect the file). Never
  // throws (the vault event handler is void), so the fire-and-forget caller stays safe.
  async removeFile(path: string): Promise<void> {
    await this.state.dequeue(path); // latest intent is a delete - cancel any queued push
    try {
      await this.deleteFile(path);
      await this.state.dequeueDelete(path);
    } catch (e) {
      await this.state.enqueueDelete(path);
      this.log(`delete ${path} failed, queued: ${(e as Error).message}`);
    }
  }

  // Delete the file doc, status-checked so a rejected DELETE throws (caller re-queues) instead
  // of dropping the rev. A doc already absent on the server is an idempotent success; the rev
  // is dropped only once the doc is confirmed gone (deleted here or already absent).
  private async deleteFile(path: string): Promise<void> {
    const id = fileId(path);
    const rev = await this.currentRev(id, path);
    if (rev !== null) await this.deleteWithRetry(id, path, rev);
    await this.state.dropRev(path);
  }

  // DELETE against `rev`; a 409 (stale rev) re-reads the fresh rev and retries once. A doc that
  // vanished between the read and the delete is an idempotent success; any other non-2xx throws.
  private async deleteWithRetry(id: string, path: string, rev: string): Promise<void> {
    let del = await this.deleteRev(id, rev);
    if (del.status === 409) {
      const fresh = await this.currentRev(id, path);
      if (fresh === null) return; // doc gone -> idempotent success
      del = await this.deleteRev(id, fresh);
    }
    if (!ok2xx(del.status)) throw new Error(`couch delete ${del.status} for ${path}`);
    this.log(`delete ${path}`);
  }

  // The server _rev for a file doc, or null if absent (404). A non-404 non-2xx read throws so
  // the delete is re-queued rather than mistaken for "already gone".
  private async currentRev(id: string, path: string): Promise<string | null> {
    const got = await this.req(`/${encodeURIComponent(id)}`);
    if (got.status === 404) return null;
    if (!ok2xx(got.status)) throw new Error(`couch delete read ${got.status} for ${path}`);
    return (got.json as FileDoc | null)?._rev ?? null;
  }

  private deleteRev(id: string, rev: string): Promise<{ status: number; json: unknown }> {
    return this.req(`/${encodeURIComponent(id)}?rev=${encodeURIComponent(rev)}`, {
      method: 'DELETE',
    });
  }

  async pushAll(): Promise<void> {
    for (const f of this.vault.getMarkdownFiles()) await this.pushFileLive(f.path);
  }

  // -- pull: couch -> vault --------------------------------------------------
  async pullOnce(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    const limit = this.cfg.pageLimit ?? DEFAULT_PAGE;
    try {
      for (;;) {
        const since = this.state.getCursor();
        const r = await this.req(
          `/_changes?since=${encodeURIComponent(since)}&include_docs=true&style=all_docs&limit=${limit}`
        );
        // A non-2xx feed (403 channel disabled / 404 db gone / 5xx) is a real failure, not an
        // empty page: throw so tick() logs it and the cursor is NOT advanced (401 already
        // re-minted once in req). Silently returning [] would mask a broken sync.
        if (!ok2xx(r.status)) throw new Error(`couch pull _changes ${r.status}`);
        const body = r.json as {
          results?: Array<{ id: string; deleted?: boolean; doc?: FileDoc }>;
          last_seq?: string;
        } | null;
        const results = body?.results ?? [];
        // Apply the whole page first; reassemble THROWS on a missing leaf, aborting the round
        // before writeVault so no truncated body is written and the cursor is not advanced.
        for (const ch of results) {
          if (!ch.id.startsWith('f:')) continue;
          const path = pathOf(ch.id);
          if (ch.deleted || ch.doc?._deleted) {
            const af = this.vault.getAbstractFileByPath(path);
            if (af) await this.vault.delete(af);
            await this.state.dropRev(path);
            continue;
          }
          if (ch.doc) await this.writeVault(path, await this.reassemble(ch.doc));
        }
        // Page fully applied - only now advance (and persist) the cursor.
        if (body?.last_seq != null) await this.state.setCursor(body.last_seq);
        if (results.length < limit || body?.last_seq == null || body.last_seq === since) break;
      }
    } finally {
      this.pulling = false;
    }
  }

  private async writeVault(path: string, body: string): Promise<void> {
    const af = this.vault.getAbstractFileByPath(path);
    if (af instanceof TFile) {
      if ((await this.vault.read(af)) === body) return; // echo guard: already in sync
      this.suppress.add(path);
      try {
        await this.vault.modify(af, body);
      } finally {
        window.setTimeout(() => this.suppress.delete(path), SUPPRESS_MS);
      }
      this.log(`pull ${path} (modify)`);
    } else {
      const dir = path.split('/').slice(0, -1).join('/');
      if (dir && !this.vault.getAbstractFileByPath(dir)) {
        await this.vault.createFolder(dir).catch(() => {});
      }
      this.suppress.add(path);
      try {
        await this.vault.create(path, body);
      } finally {
        window.setTimeout(() => this.suppress.delete(path), SUPPRESS_MS);
      }
      this.log(`pull ${path} (create)`);
    }
    // Cache the applied content rev so a later push does not echo it back to couch.
    await this.state.setRev(path, (await leafIdsOf(body)).join(','));
  }

  // Retry every queued push, then pull. The periodic tick calls this so a dropped live push
  // is not lost. Resilient: a failing pull is logged, not thrown, so the next tick retries.
  async flushPending(): Promise<void> {
    for (const path of this.state.pendingPaths()) {
      try {
        await this.pushFile(path);
        await this.state.dequeue(path);
      } catch {
        /* keep queued for the next tick */
      }
    }
    for (const path of this.state.pendingDeletePaths()) {
      try {
        await this.deleteFile(path);
        await this.state.dequeueDelete(path);
      } catch {
        /* keep queued for the next tick */
      }
    }
  }

  async tick(): Promise<void> {
    await this.flushPending();
    try {
      await this.pullOnce();
    } catch (e) {
      this.log(`pull failed (will retry): ${(e as Error).message}`);
    }
  }

  async syncNow(): Promise<void> {
    // pushAll first-syncs a non-empty local vault while the server git->couch seed is unwired;
    // safe (no OOM/timeout) because the push rev-cache skips already-converged files.
    await this.pushAll();
    await this.pullOnce();
  }
}
