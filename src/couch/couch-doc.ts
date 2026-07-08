// Content-addressed doc model shared with the server bridge: a note becomes leaf docs
// h:<sha256(chunk)> plus a file doc f:<path> that lists its leaves in order. Pure (Web
// Crypto only, no obsidian/node builtins) so it unit-tests in Node and stays mobile-safe.

const CHUNK = 64 * 1024;

// Web Crypto sha256 of the utf8 bytes - byte-identical to the server's node:crypto sha256,
// so the leaf id (which the bridge reads to reassemble) matches exactly. The leaf _rev only
// needs to be a deterministic 32-hex (couch rev shape); it need not match the server's md5
// (identical content => same id; a differing rev is a harmless same-data leaf conflict).
export const sha256hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const fileId = (p: string): string => `f:${p}`;
export const pathOf = (id: string): string => id.slice(2);

export const chunkBody = (b: string): string[] => {
  if (b.length === 0) return [''];
  const out: string[] = [];
  for (let i = 0; i < b.length; i += CHUNK) out.push(b.slice(i, i + CHUNK));
  return out;
};

export interface LeafDoc {
  _id: string;
  _rev: string;
  data: string;
}
export interface FileDoc {
  _id: string;
  _rev?: string;
  type: 'file';
  path: string;
  size: number;
  leaves: string[];
  _conflicts?: string[];
  _deleted?: boolean;
}

// The ordered leaf ids for a body - a deterministic, content-addressed signature of the
// file used both to build the file doc and to skip an unchanged push (see couch-sync).
export const leafIdsOf = async (body: string): Promise<string[]> =>
  Promise.all(chunkBody(body).map(async (c) => `h:${await sha256hex(c)}`));

export const encodeFile = async (
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

// The deterministic content rev used as the push-skip cache key (joined leaf ids).
export const contentRev = (fileDoc: Pick<FileDoc, 'leaves'>): string => fileDoc.leaves.join(',');

// The content rev for a raw body, WITHOUT building a full file doc - the exact value pushFile
// caches (contentRev(fileDoc) === leafIdsOf(body).join(',')). Lets the preview compute the
// outgoing count from vault content alone, guaranteed equal to what pushAll would send.
export const contentRevOf = async (body: string): Promise<string> =>
  (await leafIdsOf(body)).join(',');
