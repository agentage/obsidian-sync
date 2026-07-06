// DI git client. fs + http are INJECTED so it unit-tests in Node (node:fs +
// isomorphic-git/http/node) and only main.ts wires VaultFs + requestUrlHttpClient.
// Client owns history: full single-branch clone (no depth, #682), token in the
// Authorization header only (#1942), and it NEVER force-pushes - on a non-ff it
// re-pulls, merges, and re-pushes.
import git, {
  Errors,
  type FsClient,
  type HttpClient,
  type MergeDriverCallback,
  type WalkerEntry,
} from 'isomorphic-git';

export interface GitClientDeps {
  fs: FsClient;
  http: HttpClient;
}

export interface RepoCtx {
  dir: string;
  gitdir?: string;
  url: string; // token NEVER in the URL (#1942)
  ref?: string;
  token: string;
}

export interface PullResult {
  conflicted: string[];
  // True when the histories can't be 3-way merged automatically (criss-cross / multiple merge
  // bases — MergeNotSupportedError). No filepaths; the caller surfaces an actionable note.
  unmergeable?: boolean;
}

const AUTHOR = { name: 'Agentage Memory', email: 'memory@agentage.io' };

export function createGitClient({ fs, http }: GitClientDeps, mergeDriver: MergeDriverCallback) {
  // #1942: token in the Authorization HEADER only (Basic password works for most hosts).
  const onAuth = (token: string) => () => ({
    headers: { Authorization: 'Basic ' + btoa(`x-access-token:${token}`) },
  });
  const onAuthFailure = () => ({ cancel: true as const });

  // Flush VaultFs's in-memory .git/index after every op (no-op for node:fs).
  const wrapFS = async <T>(p: Promise<T>): Promise<T> => {
    const flush = (fs as { saveAndClear?: () => Promise<void> }).saveAndClear;
    try {
      const r = await p;
      if (flush) await flush.call(fs);
      return r;
    } catch (e) {
      if (flush) await flush.call(fs);
      throw e;
    }
  };

  const base = (c: RepoCtx) => ({ fs, dir: c.dir, gitdir: c.gitdir });
  const auth = (c: RepoCtx) => ({ onAuth: onAuth(c.token), onAuthFailure });

  const client = {
    // FULL single-branch clone. NO depth — shallow breaks push (#682).
    clone: (c: RepoCtx) =>
      wrapFS(
        git.clone({
          ...base(c),
          ...auth(c),
          http,
          url: c.url,
          ref: c.ref ?? 'main',
          singleBranch: true,
          noTags: true,
        })
      ),

    fetch: (c: RepoCtx) =>
      wrapFS(
        git.fetch({
          ...base(c),
          ...auth(c),
          http,
          url: c.url,
          ref: c.ref ?? 'main',
          singleBranch: true,
        })
      ),

    async pull(c: RepoCtx): Promise<PullResult> {
      const ref = c.ref ?? 'main';
      await wrapFS(
        git.fetch({ ...base(c), ...auth(c), http, url: c.url, ref, singleBranch: true })
      );
      try {
        const res = await wrapFS(
          git.merge({
            ...base(c),
            ours: ref,
            theirs: `origin/${ref}`,
            author: AUTHOR,
            abortOnConflict: false,
            mergeDriver,
          })
        );
        if (!res.alreadyMerged) await wrapFS(git.checkout({ ...base(c), ref }));
        return { conflicted: [] };
      } catch (e) {
        if (e instanceof Errors.MergeConflictError) {
          // iso-git already wrote the conflicted files WITH markers to the worktree
          // (abortOnConflict:false) — do NOT checkout, that would discard them.
          return { conflicted: e.data.filepaths };
        }
        if (e instanceof Errors.MergeNotSupportedError) {
          // Criss-cross / multiple merge bases: iso-git can't auto-merge and the worktree is
          // left intact. Signal the caller to surface a clear "resolve manually" note rather
          // than bubbling a raw error. (No auto LWW fallback — it would risk silent data loss.)
          return { conflicted: [], unmergeable: true };
        }
        throw e;
      }
    },

    // No force. A non-ff push throws PushRejectedError → re-pull + re-push (still no force).
    // Returns the conflict outcome: an empty result = pushed; a conflicted/unmergeable result
    // means the re-pull hit a conflict and we did NOT push — the caller surfaces it.
    async push(c: RepoCtx): Promise<PullResult> {
      const ref = c.ref ?? 'main';
      const doPush = () => wrapFS(git.push({ ...base(c), ...auth(c), http, url: c.url, ref }));
      try {
        const r = await doPush();
        if (!r.ok) throw new Error('push not ok');
        return { conflicted: [] };
      } catch (e) {
        if (e instanceof Errors.PushRejectedError) {
          // Someone pushed between our pull and push. Re-pull (merge); if THAT conflicts,
          // propagate it instead of blindly re-pushing into a "not ok after rebase" error.
          const pulled = await client.pull(c);
          if (pulled.conflicted.length > 0 || pulled.unmergeable) return pulled;
          const r2 = await doPush();
          if (!r2.ok) throw new Error('push not ok after rebase');
          return { conflicted: [] };
        }
        throw e;
      }
    },

    commit: (c: RepoCtx, message: string) =>
      wrapFS(git.commit({ ...base(c), message, author: AUTHOR })),
    add: (c: RepoCtx, filepath: string) => wrapFS(git.add({ ...base(c), filepath })),
    remove: (c: RepoCtx, filepath: string) => wrapFS(git.remove({ ...base(c), filepath })),
    statusMatrix: (c: RepoCtx) => wrapFS(git.statusMatrix({ ...base(c) })),
    resolveRef: (c: RepoCtx, ref: string) => git.resolveRef({ ...base(c), ref }),

    init: (c: RepoCtx) => wrapFS(git.init({ ...base(c), defaultBranch: c.ref ?? 'main' })),
    addRemote: (c: RepoCtx, remote = 'origin') =>
      wrapFS(git.addRemote({ ...base(c), remote, url: c.url, force: true })),

    // Fetch + resolve origin/<ref>; null if the remote has no such ref (empty remote).
    async remoteOid(c: RepoCtx): Promise<string | null> {
      const ref = c.ref ?? 'main';
      await wrapFS(
        git.fetch({ ...base(c), ...auth(c), http, url: c.url, ref, singleBranch: true })
      ).catch(() => undefined);
      try {
        return await git.resolveRef({ ...base(c), ref: `origin/${ref}` });
      } catch {
        return null;
      }
    },

    // Does the REMOTE actually have <ref>? Asks the server (listServerRefs), so it is
    // correct even when the local origin/<ref> tracking ref is stale from another vault.
    async remoteHasRef(c: RepoCtx): Promise<boolean> {
      const ref = c.ref ?? 'main';
      try {
        const refs = await git.listServerRefs({
          http,
          url: c.url,
          onAuth: onAuth(c.token),
          onAuthFailure,
          prefix: `refs/heads/${ref}`,
        });
        return refs.length > 0;
      } catch {
        return false; // unreachable/empty → treat as "no ref"; a later push surfaces real errors
      }
    },

    // Count of files (blobs) that differ between two commit oids - added, removed, or
    // modified. Non-mutating; the sync preview uses it to show how many files a pull will
    // bring in (incoming). git.walk descends both trees in lockstep; directories recurse.
    async changedFileCount(c: RepoCtx, oidA: string, oidB: string): Promise<number> {
      const out = await wrapFS(
        git.walk({
          ...base(c),
          trees: [git.TREE({ ref: oidA }), git.TREE({ ref: oidB })],
          map: async (filepath: string, entries: Array<WalkerEntry | null>) => {
            if (filepath === '.') return undefined;
            const [a, b] = entries;
            const ta = a ? await a.type() : undefined;
            const tb = b ? await b.type() : undefined;
            if (ta === 'tree' || tb === 'tree') return undefined; // dir node; walk recurses in
            const oa = a ? await a.oid() : null;
            const ob = b ? await b.oid() : null;
            return oa === ob ? undefined : filepath;
          },
        })
      );
      return (out as unknown[]).flat(Infinity).filter(Boolean).length;
    },
  };
  return client;
}

export type GitClient = ReturnType<typeof createGitClient>;
