// fs.promises shim over Obsidian vault.adapter for isomorphic-git (NOT LightningFS,
// so notes stay plaintext on disk for the server's git grep). Carries the in-memory
// .git/index cache; flush with saveAndClear() after every git.* op (see git-client wrapFS).
// Obsidian-only (wired in main); pass `new VaultFs(...) as unknown as FsClient`.
import { TFile, normalizePath, type DataWriteOptions, type Vault } from 'obsidian';

interface FakeStat {
  type: 'file' | 'directory';
  size: number;
  ctimeMs: number;
  mtimeMs: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data.buffer;
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
}

export class VaultFs {
  promises: Record<string, unknown> = {};
  private readonly gitDir: string;
  private index: ArrayBuffer | undefined;
  private indexctime: number | undefined;
  private indexmtime: number | undefined;

  // gitDir is the worktree-relative .git path (e.g. '.git'). Normalized so the
  // index detection matches iso-git's paths regardless of leading slashes.
  constructor(
    private readonly vault: Vault,
    gitDir: string
  ) {
    this.gitDir = normalizePath(gitDir);
    this.promises = {
      readFile: this.readFile.bind(this),
      writeFile: this.writeFile.bind(this),
      readdir: this.readdir.bind(this),
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      stat: this.stat.bind(this),
      unlink: this.unlink.bind(this),
      lstat: this.lstat.bind(this),
      readlink: this.readlink.bind(this),
      symlink: this.symlink.bind(this),
    };
  }

  // iso-git with dir='' (vault root) can emit leading-slash paths; vault.adapter
  // wants vault-relative ones. normalizePath strips the leading slash ('' -> '/').
  private rel(path: string): string {
    return normalizePath(path);
  }

  private isIndex(path: string): boolean {
    return path.endsWith(this.gitDir + '/index');
  }

  private fakeStat(
    type: 'file' | 'directory',
    size: number,
    ctimeMs: number,
    mtimeMs: number
  ): FakeStat {
    return {
      type,
      size,
      ctimeMs,
      mtimeMs,
      isFile: () => type === 'file',
      isDirectory: () => type === 'directory',
      isSymbolicLink: () => false,
    };
  }

  async readFile(
    rawPath: string,
    opts?: string | { encoding?: string }
  ): Promise<string | ArrayBuffer> {
    const path = this.rel(rawPath);
    const utf8 = opts === 'utf8' || (typeof opts === 'object' && opts?.encoding === 'utf8');
    if (utf8) {
      const f = this.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) return this.vault.read(f);
      return this.vault.adapter.read(path);
    }
    if (this.isIndex(path)) return this.index ?? this.vault.adapter.readBinary(path);
    const f = this.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) return this.vault.readBinary(f);
    return this.vault.adapter.readBinary(path);
  }

  async writeFile(rawPath: string, data: string | ArrayBufferView | ArrayBuffer): Promise<void> {
    const path = this.rel(rawPath);
    if (typeof data === 'string') {
      const f = this.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        await this.vault.modify(f, data);
        return;
      }
      return this.vault.adapter.write(path, data);
    }
    const buf = toArrayBuffer(data);
    if (this.isIndex(path)) {
      this.index = buf;
      this.indexmtime = Date.now();
      return;
    }
    const f = this.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      await this.vault.modifyBinary(f, buf);
      return;
    }
    return this.vault.adapter.writeBinary(path, buf);
  }

  async stat(rawPath: string): Promise<FakeStat> {
    const path = this.rel(rawPath);
    if (this.isIndex(path)) {
      if (this.index !== undefined && this.indexctime != null && this.indexmtime != null) {
        return this.fakeStat('file', this.index.byteLength, this.indexctime, this.indexmtime);
      }
      const s = await this.vault.adapter.stat(path);
      if (s == undefined) throw enoent();
      this.indexctime = s.ctime;
      this.indexmtime = s.mtime;
      return this.fakeStat('file', s.size, s.ctime, s.mtime);
    }
    let p = path;
    if (p === '.') p = '/';
    const f = this.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) return this.fakeStat('file', f.stat.size, f.stat.ctime, f.stat.mtime);
    const s = await this.vault.adapter.stat(p);
    if (s == undefined) throw enoent();
    return this.fakeStat(s.type === 'folder' ? 'directory' : 'file', s.size, s.ctime, s.mtime);
  }

  async lstat(path: string): Promise<FakeStat> {
    return this.stat(path);
  }

  async readdir(rawPath: string): Promise<string[]> {
    let p = this.rel(rawPath);
    if (p === '.') p = '/';
    const res = await this.vault.adapter.list(p);
    const all = [...res.files, ...res.folders];
    return p !== '/' ? all.map((e) => normalizePath(e.substring(p.length + 1))) : all;
  }

  async mkdir(path: string): Promise<void> {
    return this.vault.adapter.mkdir(this.rel(path));
  }
  async rmdir(path: string): Promise<void> {
    return this.vault.adapter.rmdir(this.rel(path), false);
  }
  async unlink(path: string): Promise<void> {
    return this.vault.adapter.remove(this.rel(path));
  }
  async readlink(path: string): Promise<never> {
    throw new Error(`readlink(${path}) not supported`);
  }
  async symlink(path: string): Promise<never> {
    throw new Error(`symlink(${path}) not supported`);
  }

  // Persist the in-memory index to disk. Call after every git.* op (wrapFS).
  async saveAndClear(): Promise<void> {
    if (this.index !== undefined) {
      const opts: DataWriteOptions = { ctime: this.indexctime, mtime: this.indexmtime };
      await this.vault.adapter.writeBinary(this.gitDir + '/index', this.index, opts);
    }
    this.index = undefined;
    this.indexctime = undefined;
    this.indexmtime = undefined;
  }
}
