import { describe, expect, it } from 'vitest';
import { applyDocToVault, type VaultGateway } from './apply-doc';
import { createEchoSuppress } from './echo-suppress';

interface FakeFile {
  path: string;
  content: string;
}

/** In-memory VaultGateway recording the ops applyDocToVault performs. */
function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, FakeFile>(
    Object.entries(initial).map(([path, content]) => [path, { path, content }])
  );
  const folders = new Set<string>();
  const ops: string[] = [];

  const gateway: VaultGateway = {
    // Minimal stand-in for Obsidian's normalizePath: convert backslashes,
    // collapse repeated slashes, strip leading/trailing slashes. Like the real
    // one, it does NOT resolve `..` segments.
    normalizePath(path) {
      return path
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/+|\/+$/g, '');
    },
    getFile(path) {
      return files.get(path) ?? null;
    },
    async read(file) {
      return (file as FakeFile).content;
    },
    async modify(file, content) {
      (file as FakeFile).content = content;
      ops.push(`modify:${(file as FakeFile).path}`);
    },
    async trash(file) {
      files.delete((file as FakeFile).path);
      ops.push(`trash:${(file as FakeFile).path}`);
    },
    async create(path, content) {
      files.set(path, { path, content });
      ops.push(`create:${path}`);
    },
    async ensureParentFolder(path) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent) {
        folders.add(parent);
        ops.push(`folder:${parent}`);
      }
    },
    async listNotes() {
      return [...files.values()].map((f) => ({ path: f.path, content: f.content, mtime: 0 }));
    },
  };

  return { gateway, files, folders, ops };
}

describe('applyDocToVault', () => {
  it('creates a new note that does not exist yet', async () => {
    const { gateway, files, ops } = fakeVault();
    await applyDocToVault(gateway, { _id: 'a.md', content: 'hello' }, createEchoSuppress());
    expect(files.get('a.md')?.content).toBe('hello');
    expect(ops).toEqual(['create:a.md']);
  });

  it('creates the parent folder before creating a nested note', async () => {
    const { gateway, folders, ops } = fakeVault();
    await applyDocToVault(gateway, { _id: 'sub/dir/a.md', content: 'x' }, createEchoSuppress());
    expect(folders.has('sub/dir')).toBe(true);
    expect(ops).toEqual(['folder:sub/dir', 'create:sub/dir/a.md']);
  });

  it('modifies an existing note when content differs', async () => {
    const { gateway, files, ops } = fakeVault({ 'a.md': 'old' });
    await applyDocToVault(gateway, { _id: 'a.md', content: 'new' }, createEchoSuppress());
    expect(files.get('a.md')?.content).toBe('new');
    expect(ops).toEqual(['modify:a.md']);
  });

  it('is a no-op when existing content already matches', async () => {
    const { gateway, ops } = fakeVault({ 'a.md': 'same' });
    await applyDocToVault(gateway, { _id: 'a.md', content: 'same' }, createEchoSuppress());
    expect(ops).toEqual([]);
  });

  it('trashes an existing note on a tombstone', async () => {
    const { gateway, files, ops } = fakeVault({ 'a.md': 'bye' });
    await applyDocToVault(gateway, { _id: 'a.md', _deleted: true }, createEchoSuppress());
    expect(files.has('a.md')).toBe(false);
    expect(ops).toEqual(['trash:a.md']);
  });

  it('ignores a tombstone for a note that is already gone', async () => {
    const { gateway, ops } = fakeVault();
    await applyDocToVault(gateway, { _id: 'a.md', _deleted: true }, createEchoSuppress());
    expect(ops).toEqual([]);
  });

  it('treats a missing content field as an empty note', async () => {
    const { gateway, files } = fakeVault();
    await applyDocToVault(gateway, { _id: 'a.md' }, createEchoSuppress());
    expect(files.get('a.md')?.content).toBe('');
  });

  it('does nothing when the doc has no _id', async () => {
    const { gateway, ops } = fakeVault();
    await applyDocToVault(gateway, { _id: '', content: 'x' }, createEchoSuppress());
    expect(ops).toEqual([]);
  });

  it('marks every write on the echo guard so it will be suppressed once', async () => {
    const echo = createEchoSuppress();
    const { gateway } = fakeVault();
    await applyDocToVault(gateway, { _id: 'a.md', content: 'hi' }, echo);
    // The vault event fired by our own write is consumed exactly once.
    expect(echo.consume('a.md')).toBe(true);
    expect(echo.consume('a.md')).toBe(false);
  });

  it('normalizes a hostile leading-slash _id and marks echo on the clean path', async () => {
    const echo = createEchoSuppress();
    const { gateway, files, ops } = fakeVault();
    await applyDocToVault(gateway, { _id: '/notes//leaked.md', content: 'x' }, echo);
    // Written at the normalized path, not the raw one.
    expect(files.get('notes/leaked.md')?.content).toBe('x');
    expect(files.get('/notes//leaked.md')).toBeUndefined();
    expect(ops).toEqual(['folder:notes', 'create:notes/leaked.md']);
    // Echo is marked on the normalized path so the resulting vault event matches.
    expect(echo.consume('notes/leaked.md')).toBe(true);
  });

  it('refuses a _id that escapes the vault with `..`', async () => {
    const { gateway, files, ops } = fakeVault();
    await applyDocToVault(
      gateway,
      { _id: 'notes/../../escape.md', content: 'x' },
      createEchoSuppress()
    );
    expect(ops).toEqual([]);
    expect(files.size).toBe(0);
  });
});
