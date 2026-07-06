import { requestUrl, TFile, type Vault } from 'obsidian';

// Experimental CouchDB sync channel (thin client, the onepager's "thin client" option).
// Replicates the vault's markdown to a per-memory CouchDB using the SAME content-addressed
// model the server bridge expects: leaf docs h:<sha256(chunk)> + a file doc f:<path>. The
// bridge then commits every couch edit to git. Uses Obsidian's requestUrl (no CORS, no
// PouchDB bundle) + Web Crypto (mobile-safe, no node builtins). Echo-safe: a push/pull
// whose content already matches is skipped, so the vault<->couch<->git loop converges.

const CHUNK = 64 * 1024;
// Web Crypto sha256 of the utf8 bytes - byte-identical to the server's node:crypto sha256,
// so the leaf id (which the bridge reads to reassemble) matches exactly. The leaf _rev only
// needs to be a deterministic 32-hex (couch rev shape); it need not match the server's md5
// (identical content => same id; a differing rev is a harmless same-data leaf conflict).
const sha256hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const fileId = (p: string): string => `f:${p}`;
const pathOf = (id: string): string => id.slice(2);

const chunkBody = (b: string): string[] => {
  if (b.length === 0) return [''];
  const out: string[] = [];
  for (let i = 0; i < b.length; i += CHUNK) out.push(b.slice(i, i + CHUNK));
  return out;
};

interface LeafDoc {
  _id: string;
  _rev: string;
  data: string;
}
interface FileDoc {
  _id: string;
  _rev?: string;
  type: 'file';
  path: string;
  size: number;
  leaves: string[];
  _conflicts?: string[];
  _deleted?: boolean;
}

const encodeFile = async (
  path: string,
  body: string
): Promise<{ leaves: LeafDoc[]; fileDoc: FileDoc }> => {
  const leaves = await Promise.all(
    chunkBody(body).map(async (c) => {
      const h = await sha256hex(c);
      return { _id: `h:${h}`, _rev: `1-${h.slice(0, 32)}`, data: c };
    })
  );
  const ids = leaves.map((l) => l._id);
  return {
    leaves,
    fileDoc: { _id: fileId(path), type: 'file', path, size: body.length, leaves: ids },
  };
};

export interface CouchSyncConfig {
  endpoint: string; // discovered couch host, e.g. https://couch.<fqdn>
  db: string; // discovered per-memory db name (mem_<hash>)
}

// Mints/caches the couch JWT (CouchTokenClient.token); the header is always "Bearer <jwt>".
export type CouchAuthorize = () => Promise<string>;

export class CouchSync {
  private cursor = '0';
  private pulling = false;
  private suppress = new Set<string>(); // paths being written by a pull (skip their push)

  constructor(
    private vault: Vault,
    private cfg: CouchSyncConfig,
    private authorize: CouchAuthorize, // supplies a valid couch JWT (see CouchTokenClient)
    private onUnauthorized: () => void, // drop the token cache so a 401 retry re-mints
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

  private async getDoc(id: string, rev?: string): Promise<FileDoc | (LeafDoc & FileDoc) | null> {
    const r = await this.req(
      `/${encodeURIComponent(id)}${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`
    );
    return r.status === 200 ? (r.json as FileDoc) : null;
  }
  private async reassemble(fdoc: FileDoc): Promise<string> {
    const parts: string[] = [];
    for (const id of fdoc.leaves) {
      const leaf = (await this.getDoc(id)) as unknown as LeafDoc | null;
      parts.push(leaf?.data ?? '');
    }
    return parts.join('');
  }

  // ── push: vault -> couch ────────────────────────────────────────────────────
  async pushFile(path: string): Promise<void> {
    if (this.suppress.has(path)) return; // we are mid-pull-writing this file
    const af = this.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile) || af.extension !== 'md') return;
    const body = await this.vault.read(af);
    const { leaves, fileDoc } = await encodeFile(path, body);
    const cur = await this.getDoc(fileDoc._id);
    if (cur && !cur._deleted && JSON.stringify(cur.leaves) === JSON.stringify(fileDoc.leaves))
      return; // converged
    await this.req('/_bulk_docs', {
      method: 'POST',
      body: JSON.stringify({ new_edits: false, docs: leaves }),
    });
    const put: FileDoc = { ...fileDoc };
    if (cur && cur._rev) put._rev = cur._rev; // normal update so this device's edit wins
    const r = await this.req(`/${encodeURIComponent(put._id)}`, {
      method: 'PUT',
      body: JSON.stringify(put),
    });
    this.log(`push ${path} -> ${r.status}`);
  }

  async removeFile(path: string): Promise<void> {
    const cur = await this.getDoc(fileId(path));
    if (cur?._rev) {
      await this.req(`/${encodeURIComponent(fileId(path))}?rev=${encodeURIComponent(cur._rev)}`, {
        method: 'DELETE',
      });
      this.log(`delete ${path}`);
    }
  }

  async pushAll(): Promise<void> {
    for (const f of this.vault.getMarkdownFiles()) await this.pushFile(f.path);
  }

  // ── pull: couch -> vault ────────────────────────────────────────────────────
  async pullOnce(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    try {
      const r = await this.req(
        `/_changes?since=${encodeURIComponent(this.cursor)}&include_docs=true&style=all_docs`
      );
      const body = r.json as {
        results?: Array<{ id: string; deleted?: boolean; doc?: FileDoc }>;
        last_seq?: string;
      } | null;
      for (const ch of body?.results ?? []) {
        if (!ch.id.startsWith('f:')) continue;
        const path = pathOf(ch.id);
        if (ch.deleted || ch.doc?._deleted) {
          const af = this.vault.getAbstractFileByPath(path);
          if (af) await this.vault.delete(af);
          continue;
        }
        if (ch.doc) await this.writeVault(path, await this.reassemble(ch.doc));
      }
      if (body?.last_seq) this.cursor = body.last_seq;
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
        window.setTimeout(() => this.suppress.delete(path), 200);
      }
      this.log(`pull ${path} (modify)`);
      return;
    }
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir && !this.vault.getAbstractFileByPath(dir)) {
      await this.vault.createFolder(dir).catch(() => {});
    }
    this.suppress.add(path);
    try {
      await this.vault.create(path, body);
    } finally {
      window.setTimeout(() => this.suppress.delete(path), 200);
    }
    this.log(`pull ${path} (create)`);
  }

  async syncNow(): Promise<void> {
    await this.pushAll();
    await this.pullOnce();
  }
}
