// Sync lifecycle orchestration (DI, no Obsidian import → unit-testable against a real
// local git server). Ties the git client + 3-way merge + backup ref together:
//   ensure repo (clone | seed | adopt-guard) → pull(merge) → on conflict: surface, stop
//   → stage local changes (skip conflicts) → commit → push (never force).
// Single-flight. main wires the Obsidian fs/http + token; tests inject node fs + a
// node-http git client.
import type { FsClient } from 'isomorphic-git';
import type { GitClient, RepoCtx } from './git/git-client';
import { snapshotBackupRef } from './git/backup-ref';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'conflict';

export interface SyncControllerDeps {
  client: GitClient;
  fs: FsClient;
  dir: string; // worktree
  gitdir?: string; // defaults `${dir}/.git`
  ref?: string; // default 'main'
  ignore?: string[]; // worktree-relative paths never staged (e.g. the config folder)
  conflictNote?: string; // default 'Agentage Sync Conflicts.md'
  onStatus?: (s: SyncStatus, msg?: string) => void;
  now: () => string; // backup-ref label
}

export interface SyncOpts {
  url: string;
  token: string;
}

export interface SyncResult {
  action: 'cloned' | 'seeded' | 'synced' | 'blocked';
  committed: boolean;
  pushed: boolean;
  conflicted: string[];
  message?: string;
}

// Empty `a` (mobile: dir = '' = vault root) must yield `b`, not `/b` — a leading
// slash breaks vault.adapter paths (.git, the conflict note). Desktop dir is an
// absolute path (truthy), so it is unaffected.
const joinPath = (a: string, b: string): string => (a ? `${a.replace(/\/+$/, '')}/${b}` : b);

export function createSyncController(deps: SyncControllerDeps) {
  const ref = deps.ref ?? 'main';
  const gitdir = deps.gitdir ?? joinPath(deps.dir, '.git');
  const conflictNote = deps.conflictNote ?? 'Agentage Sync Conflicts.md';
  const status = (s: SyncStatus, msg?: string) => deps.onStatus?.(s, msg);
  let running = false;

  // FsClient is a callback|promise union; the concrete fs we get (node fs / VaultFs)
  // always has a promises API — narrow to the subset we use here.
  const pfs = deps.fs as unknown as {
    promises: {
      stat(p: string): Promise<unknown>;
      readdir(p: string): Promise<string[]>;
      writeFile(p: string, data: string): Promise<void>;
    };
  };

  const ctxOf = (o: SyncOpts): RepoCtx => ({
    dir: deps.dir,
    gitdir,
    url: o.url,
    ref,
    token: o.token,
  });

  const skip = (p: string): boolean =>
    p === conflictNote || (deps.ignore?.some((i) => p === i || p.startsWith(i + '/')) ?? false);

  async function hasGit(): Promise<boolean> {
    try {
      await pfs.promises.stat(gitdir);
      return true;
    } catch {
      return false;
    }
  }

  // Local branch head, or null when `main` is unborn (repo init'd, no commit yet).
  async function localHead(ctx: RepoCtx): Promise<string | null> {
    try {
      return await deps.client.resolveRef(ctx, ref);
    } catch {
      return null;
    }
  }

  async function dirIsEmpty(): Promise<boolean> {
    let entries: string[] = [];
    try {
      entries = await pfs.promises.readdir(deps.dir);
    } catch {
      return true;
    }
    return entries.filter((e) => !e.startsWith('.')).length === 0;
  }

  async function stageChanges(ctx: RepoCtx, conflicted: Set<string>): Promise<number> {
    const matrix = await deps.client.statusMatrix(ctx);
    let staged = 0;
    for (const row of matrix) {
      const [filepath, head, workdir] = row as [string, number, number, number];
      if (skip(filepath) || conflicted.has(filepath)) continue;
      if (workdir === 0 && head === 1) {
        await deps.client.remove(ctx, filepath);
        staged++;
      } else if (workdir !== head) {
        await deps.client.add(ctx, filepath);
        staged++;
      }
    }
    return staged;
  }

  async function writeConflictNote(conflicted: string[]): Promise<void> {
    const body =
      `---\nconflict: true\nupdated: ${deps.now()}\n---\n\n` +
      `# Sync conflicts\n\nThese files have unresolved conflict markers (\`<<<<<<<\`). ` +
      `Open each, keep the right content, remove the markers, then sync again.\n\n` +
      conflicted.map((f) => `- [[${f}]]`).join('\n') +
      '\n';
    await pfs.promises.writeFile(joinPath(deps.dir, conflictNote), body);
  }

  async function run(o: SyncOpts): Promise<SyncResult> {
    status('syncing');
    const ctx = ctxOf(o);

    if (!(await hasGit())) {
      if (await dirIsEmpty()) {
        await deps.client.clone(ctx);
        status('idle');
        return { action: 'cloned', committed: false, pushed: false, conflicted: [] };
      }
      // non-empty worktree, no repo → init + adopt-guard
      await deps.client.init(ctx);
      await deps.client.addRemote(ctx);
      const remote = await deps.client.remoteOid(ctx);
      if (remote !== null) {
        const message =
          'Remote already has notes. First sync into a non-empty vault is not supported yet — start from an empty vault or an empty remote.';
        status('error', message);
        return { action: 'blocked', committed: false, pushed: false, conflicted: [], message };
      }
      const staged = await stageChanges(ctx, new Set());
      if (staged > 0) await deps.client.commit(ctx, 'Import local notes');
      await deps.client.push(ctx);
      status('idle');
      return { action: 'seeded', committed: staged > 0, pushed: true, conflicted: [] };
    }

    // existing local repo. Ask the SERVER whether the target memory has commits (not the
    // local origin/<ref>, which is stale after switching vaults): a just-created memory has
    // no `main`, so there is nothing to pull/merge — seed it (commit local + push) instead
    // of pulling, which would throw "could not get main".
    const remoteHasHistory = await deps.client.remoteHasRef(ctx);
    if (!remoteHasHistory) {
      const staged = await stageChanges(ctx, new Set());
      if (staged > 0) await deps.client.commit(ctx, `Sync ${deps.now()}`);
      const pushed = (await localHead(ctx)) !== null; // nothing to push if local is empty too
      if (pushed) await deps.client.push(ctx);
      status('idle');
      return { action: 'seeded', committed: staged > 0, pushed, conflicted: [] };
    }

    // remote has history: backup HEAD → COMMIT local first (commit-before-pull, so a merge
    // never has to overwrite uncommitted work) → pull(merge) → surface conflicts → push.
    if (await localHead(ctx))
      await snapshotBackupRef(deps.fs, { dir: deps.dir, gitdir, ref }, deps.now());
    const staged = await stageChanges(ctx, new Set());
    if (staged > 0) await deps.client.commit(ctx, `Sync ${deps.now()}`);

    const { conflicted } = await deps.client.pull(ctx);
    if (conflicted.length > 0) {
      await writeConflictNote(conflicted);
      status('conflict', `${conflicted.length} file(s) need resolution`);
      return { action: 'synced', committed: staged > 0, pushed: false, conflicted };
    }

    await deps.client.push(ctx);
    status('idle');
    return { action: 'synced', committed: staged > 0, pushed: true, conflicted: [] };
  }

  return {
    isRunning: () => running,
    async syncNow(o: SyncOpts): Promise<SyncResult> {
      if (running) throw new Error('sync already running');
      running = true;
      try {
        return await run(o);
      } catch (e) {
        status('error', (e as Error).message);
        throw e;
      } finally {
        running = false;
      }
    },
  };
}

export type SyncController = ReturnType<typeof createSyncController>;
