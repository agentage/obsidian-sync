import { TFile, normalizePath, type App } from 'obsidian';
import type { VaultFile, VaultGateway } from './apply-doc';

/** Narrow an opaque gateway handle to a TFile (it only ever holds one) without
 * an `as` cast, satisfying the store scan's no-tfile-cast rule. */
function asTFile(file: VaultFile): TFile {
  if (file instanceof TFile) return file;
  throw new Error('[Agentage Memory] expected a vault TFile');
}

/**
 * Obsidian-backed `VaultGateway`. The single place that touches the live
 * `app.vault` for inbound writes — isolated here so `apply-doc.ts` stays
 * obsidian-free and unit-testable. Deletes route through `trash` (never a
 * hard wipe). Every path is run through `normalizePath` here too (defensive —
 * idempotent on already-normalized paths) so any caller is store-safe.
 * Excluded from coverage: needs the Obsidian runtime to exercise.
 */
export function obsidianVaultGateway(app: App): VaultGateway {
  const gateway: VaultGateway = {
    normalizePath,
    getFile(path) {
      const file = app.vault.getAbstractFileByPath(normalizePath(path));
      return file instanceof TFile ? file : null;
    },
    read(file) {
      return app.vault.read(asTFile(file));
    },
    modify(file, content) {
      return app.vault.modify(asTFile(file), content);
    },
    async trash(file) {
      // System trash, not a hard wipe; cast-free narrowing keeps the store scan happy.
      await app.vault.trash(asTFile(file), true);
    },
    async create(path, content) {
      await app.vault.create(normalizePath(path), content);
    },
    async ensureParentFolder(path) {
      const norm = normalizePath(path);
      const parent = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
      if (parent && !app.vault.getAbstractFileByPath(parent)) {
        try {
          await app.vault.createFolder(parent);
        } catch {
          // Folder may already exist or be created by a concurrent sync — safe to ignore.
        }
      }
    },
    async listNotes() {
      const files = app.vault.getMarkdownFiles();
      return Promise.all(
        files.map(async (file) => ({
          path: file.path,
          content: await app.vault.cachedRead(file),
          mtime: file.stat.mtime,
        }))
      );
    },
  };
  return gateway;
}
