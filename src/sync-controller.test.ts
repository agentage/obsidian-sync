import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type MergeDriverCallback } from 'isomorphic-git';
import nodeHttp from 'isomorphic-git/http/node';
import { startGitServer, type GitServer } from './git/git-test-server';
import { createGitClient } from './git/git-client';
import { mergeNote } from './git/merge-note';
import { createSyncController } from './sync-controller';

const mergeDriver: MergeDriverCallback = ({ contents }) => {
  const [b, o, t] = contents;
  const { text, clean } = mergeNote(b, o, t);
  return { cleanMerge: clean, mergedText: text };
};
const client = createGitClient({ fs, http: nodeHttp }, mergeDriver);
// A realistic ISO timestamp (with colons) — backup-ref labels must survive it (ref names forbid ':').
const controllerFor = (dir: string) =>
  createSyncController({ client, fs, dir, now: () => '2026-06-21T00:00:00.000Z' });

let root: string;
let tmp: string;
let srv: GitServer;
let url: string;
const opts = (u = url) => ({ url: u, token: 't' });

function dir(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsrv-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', path.join(root, 'app.git')]);
  srv = await startGitServer(root);
  url = srv.url('app.git');
});
afterEach(async () => {
  await srv.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sync-controller (R10/R12 lifecycle + R15 conflict surfacing)', () => {
  it('seeds an empty remote from a non-empty vault, then another vault clones it', async () => {
    const A = dir('A');
    fs.writeFileSync(path.join(A, 'note.md'), '# hi\n');
    const seed = await controllerFor(A).syncNow(opts());
    expect(seed.action).toBe('seeded');
    expect(seed.pushed).toBe(true);

    const B = dir('B');
    const cloned = await controllerFor(B).syncNow(opts());
    expect(cloned.action).toBe('cloned');
    expect(fs.readFileSync(path.join(B, 'note.md'), 'utf8')).toContain('# hi');
  });

  it('syncs an existing local repo into a freshly-created EMPTY remote by seeding it (no "could not get main")', async () => {
    const A = dir('A');
    fs.writeFileSync(path.join(A, 'note.md'), 'hello\n');
    await controllerFor(A).syncNow(opts()); // seeds app.git; A now has a local .git

    // a brand-new memory, like POST /vaults makes it: a bare repo with no commits/main ref
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', path.join(root, 'fresh.git')]);
    const freshUrl = srv.url('fresh.git');

    const res = await controllerFor(A).syncNow(opts(freshUrl)); // must NOT throw
    expect(res.action).toBe('seeded');
    expect(res.pushed).toBe(true);

    const C = dir('C');
    const cloned = await controllerFor(C).syncNow(opts(freshUrl));
    expect(cloned.action).toBe('cloned');
    expect(fs.readFileSync(path.join(C, 'note.md'), 'utf8')).toContain('hello');
  });

  it('commits + pushes a local edit; another vault pulls it', async () => {
    const A = dir('A');
    fs.writeFileSync(path.join(A, 'note.md'), 'v1\n');
    await controllerFor(A).syncNow(opts());
    const B = dir('B');
    await controllerFor(B).syncNow(opts()); // clone

    fs.writeFileSync(path.join(A, 'note.md'), 'v1\nv2\n');
    const synced = await controllerFor(A).syncNow(opts());
    expect(synced.action).toBe('synced');
    expect(synced.committed).toBe(true);

    const pulled = await controllerFor(B).syncNow(opts());
    expect(pulled.conflicted).toEqual([]);
    expect(fs.readFileSync(path.join(B, 'note.md'), 'utf8')).toContain('v2');
  });

  it('surfaces a true conflict (markers + conflict note) and does not push', async () => {
    const A = dir('A');
    fs.writeFileSync(path.join(A, 'note.md'), 'base\n');
    await controllerFor(A).syncNow(opts());
    const B = dir('B');
    await controllerFor(B).syncNow(opts()); // clone

    fs.writeFileSync(path.join(A, 'note.md'), 'A-change\n');
    await controllerFor(A).syncNow(opts()); // A pushes

    fs.writeFileSync(path.join(B, 'note.md'), 'B-change\n'); // same line → conflict
    const res = await controllerFor(B).syncNow(opts());
    expect(res.conflicted).toContain('note.md');
    expect(res.pushed).toBe(false);
    expect(fs.readFileSync(path.join(B, 'note.md'), 'utf8')).toContain('<<<<<<<');
    expect(fs.existsSync(path.join(B, 'Agentage Sync Conflicts.md'))).toBe(true);
  });

  it('is single-flight (a concurrent sync is rejected)', async () => {
    const A = dir('A');
    fs.writeFileSync(path.join(A, 'note.md'), 'x\n');
    await controllerFor(A).syncNow(opts()); // seed
    const ctrl = controllerFor(A);
    const [r1, r2] = await Promise.allSettled([ctrl.syncNow(opts()), ctrl.syncNow(opts())]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
  });
});
