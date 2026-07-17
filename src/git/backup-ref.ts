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
  // Git ref names forbid ':' (and more) — an ISO timestamp label would be rejected, so
  // reduce the label to ref-safe chars (e.g. 2026-06-21T00:28:48.1Z -> 2026-06-21T00-28-48-1Z).
  const safe = label.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '') || 'snapshot';
  const backup = `refs/agentage/local-${safe}`;
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
