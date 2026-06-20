// Data-loss guard (R16): before any operation that could discard local state (a
// server-wins reset or a criss-cross fallback), snapshot HEAD at a recoverable
// ref `refs/agentage/local-<label>`. DI fs so it unit-tests in Node.
import git, { type FsClient } from 'isomorphic-git';

export interface RefCtx {
  dir: string;
  gitdir?: string;
  ref?: string; // branch, default 'main'
}

export async function snapshotBackupRef(fs: FsClient, c: RefCtx, label: string): Promise<string> {
  const ref = c.ref ?? 'main';
  const oid = await git.resolveRef({ fs, dir: c.dir, gitdir: c.gitdir, ref });
  const backup = `refs/agentage/local-${label}`;
  await git.writeRef({ fs, dir: c.dir, gitdir: c.gitdir, ref: backup, value: oid, force: true });
  return backup;
}

/** Restore the branch to a backup ref (recover from a bad merge). */
export async function restoreBackupRef(fs: FsClient, c: RefCtx, backup: string): Promise<void> {
  const ref = c.ref ?? 'main';
  const oid = await git.resolveRef({ fs, dir: c.dir, gitdir: c.gitdir, ref: backup });
  await git.writeRef({
    fs,
    dir: c.dir,
    gitdir: c.gitdir,
    ref: `refs/heads/${ref}`,
    value: oid,
    force: true,
  });
  await git.checkout({ fs, dir: c.dir, gitdir: c.gitdir, ref, force: true });
}
