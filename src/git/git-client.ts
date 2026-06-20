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
          await wrapFS(git.checkout({ ...base(c), ref })).catch(() => undefined);
          return { conflicted: e.data.filepaths };
        }
        throw e; // MergeNotSupportedError (criss-cross) handled by the caller (backup + LWW)
      }
    },

    // No force. A non-ff push throws PushRejectedError → re-pull + re-push (still no force).
    async push(c: RepoCtx): Promise<void> {
      const ref = c.ref ?? 'main';
      const doPush = () => wrapFS(git.push({ ...base(c), ...auth(c), http, url: c.url, ref }));
      try {
        const r = await doPush();
        if (!r.ok) throw new Error('push not ok');
      } catch (e) {
        if (e instanceof Errors.PushRejectedError) {
          await client.pull(c);
          const r2 = await doPush();
          if (!r2.ok) throw new Error('push not ok after rebase');
          return;
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
  };
  return client;
}

export type GitClient = ReturnType<typeof createGitClient>;
