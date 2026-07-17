import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git, { type MergeDriverCallback } from 'isomorphic-git';
import nodeHttp from 'isomorphic-git/http/node';
import { startGitServer, type GitServer } from './git-test-server';
import { createGitClient } from './git-client';
import { mergeNote } from './merge-note';

const author = { name: 'tester', email: 't@e.io' };
const onAuth = () => ({ headers: { Authorization: 'Bearer test-token' } });
const mergeDriver: MergeDriverCallback = ({ contents }) => {
  const [b, o, t] = contents;
  const { text, clean } = mergeNote(b, o, t);
  return { cleanMerge: clean, mergedText: text };
};
const client = createGitClient({ fs, http: nodeHttp }, mergeDriver);

let root: string;
let tmp: string;
let srv: GitServer;
let url: string;

async function seedBare(): Promise<void> {
  const S = path.join(tmp, 'seed');
  fs.mkdirSync(S, { recursive: true });
  await git.init({ fs, dir: S, defaultBranch: 'main' });
  await git.addRemote({ fs, dir: S, remote: 'origin', url });
  fs.writeFileSync(path.join(S, 'seed.md'), '# seed\n');
  await git.add({ fs, dir: S, filepath: 'seed.md' });
  await git.commit({ fs, dir: S, message: 'seed', author });
  await git.push({ fs, http: nodeHttp, dir: S, remote: 'origin', ref: 'main', onAuth });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsrv-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', path.join(root, 'app.git')]);
  srv = await startGitServer(root);
  url = srv.url('app.git');
  await seedBare();
});
afterEach(async () => {
  await srv.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('git-client (R8 clone, R11 push, R13 never-force)', () => {
  it('clones the vault full single-branch; token never in the URL', async () => {
    const B = path.join(tmp, 'B');
    await client.clone({ dir: B, url, token: 'test-token' });
    expect(fs.readFileSync(path.join(B, 'seed.md'), 'utf8')).toContain('# seed');
    expect(url).not.toContain('test-token'); // R9: token only via onAuth header
  });

  it('commits and pushes a local edit; a second clone sees it', async () => {
    const B = path.join(tmp, 'B');
    await client.clone({ dir: B, url, token: 't' });
    fs.writeFileSync(path.join(B, 'note.md'), '# from B\n');
    await client.add({ dir: B, url, token: 't' }, 'note.md');
    await client.commit({ dir: B, url, token: 't' }, 'add note');
    await client.push({ dir: B, url, token: 't' });

    const C = path.join(tmp, 'C');
    await client.clone({ dir: C, url, token: 't' });
    expect(fs.readFileSync(path.join(C, 'note.md'), 'utf8')).toContain('# from B');
  });

  it('on a non-ff push, re-pulls + merges + re-pushes (never force); both edits land', async () => {
    const A = path.join(tmp, 'A');
    const B = path.join(tmp, 'B');
    await client.clone({ dir: A, url, token: 't' });
    await client.clone({ dir: B, url, token: 't' });

    // A pushes first
    fs.writeFileSync(path.join(A, 'a.md'), 'A\n');
    await client.add({ dir: A, url, token: 't' }, 'a.md');
    await client.commit({ dir: A, url, token: 't' }, 'A commit');
    await client.push({ dir: A, url, token: 't' });

    // B commits on the now-stale base, then pushes -> auto-recovers (no force)
    fs.writeFileSync(path.join(B, 'b.md'), 'B\n');
    await client.add({ dir: B, url, token: 't' }, 'b.md');
    await client.commit({ dir: B, url, token: 't' }, 'B commit');
    await client.push({ dir: B, url, token: 't' }); // must not throw, must not force

    const D = path.join(tmp, 'D');
    await client.clone({ dir: D, url, token: 't' });
    expect(fs.existsSync(path.join(D, 'a.md'))).toBe(true);
    expect(fs.existsSync(path.join(D, 'b.md'))).toBe(true);
  });
});

describe('changedFileCount (sync preview)', () => {
  it('counts added + modified blobs between two commits (subdirs recurse, dirs not counted)', async () => {
    const B = path.join(tmp, 'B');
    const ctx = { dir: B, url, token: 't' };
    await client.clone(ctx);
    const before = await client.resolveRef(ctx, 'main');

    fs.writeFileSync(path.join(B, 'seed.md'), '# seed v2\n'); // modified
    fs.mkdirSync(path.join(B, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(B, 'notes', 'new.md'), 'new\n'); // added, in a subdir
    await client.add(ctx, 'seed.md');
    await client.add(ctx, 'notes/new.md');
    await client.commit(ctx, 'edit');
    const after = await client.resolveRef(ctx, 'main');

    expect(await client.changedFileCount(ctx, before, after)).toBe(2);
    // Symmetric: the reverse direction sees the same paths (one now a deletion).
    expect(await client.changedFileCount(ctx, after, before)).toBe(2);
  });

  it('returns 0 when both oids are the same commit', async () => {
    const B = path.join(tmp, 'B');
    const ctx = { dir: B, url, token: 't' };
    await client.clone(ctx);
    const head = await client.resolveRef(ctx, 'main');
    expect(await client.changedFileCount(ctx, head, head)).toBe(0);
  });
});
