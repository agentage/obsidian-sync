import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { snapshotBackupRef, restoreBackupRef } from './backup-ref';

const author = { name: 't', email: 't@e.io' };
let dir: string;

async function commit(file: string, body: string, message: string): Promise<string> {
  fs.writeFileSync(path.join(dir, file), body);
  await git.add({ fs, dir, filepath: file });
  return git.commit({ fs, dir, message, author });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  await git.init({ fs, dir, defaultBranch: 'main' });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('backup-ref (R16 data-loss guard)', () => {
  it('snapshots HEAD at refs/agentage/local-<label> and restores it', async () => {
    const first = await commit('note.md', 'v1\n', 'c1');
    const backup = await snapshotBackupRef(fs, { dir }, '20260620');
    expect(backup).toBe('refs/agentage/local-20260620');
    expect(await git.resolveRef({ fs, dir, ref: backup })).toBe(first);

    // advance main (simulate a clobbering write)
    await commit('note.md', 'v2-clobbered\n', 'c2');
    expect(fs.readFileSync(path.join(dir, 'note.md'), 'utf8')).toContain('v2-clobbered');

    // restore from the backup → main back at c1, worktree reverted
    await restoreBackupRef(fs, { dir }, backup);
    expect(await git.resolveRef({ fs, dir, ref: 'main' })).toBe(first);
    expect(fs.readFileSync(path.join(dir, 'note.md'), 'utf8')).toContain('v1');
  });
});
