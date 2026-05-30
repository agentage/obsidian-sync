import { TFile, normalizePath, type App } from 'obsidian';
import type { VaultGateway } from './apply-doc';

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
      return app.vault.read(file as TFile);
    },
    modify(file, content) {
      return app.vault.modify(file as TFile, content);
    },
    async trash(file) {
      await app.vault.trash(file as TFile, true);
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
