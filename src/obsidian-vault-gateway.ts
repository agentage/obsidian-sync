import { TFile, type App } from 'obsidian';
import type { VaultGateway } from './apply-doc';

/**
 * Obsidian-backed `VaultGateway`. The single place that touches the live
 * `app.vault` for inbound writes — isolated here so `apply-doc.ts` stays
 * obsidian-free and unit-testable. Deletes route through `trash` (never a
 * hard wipe). Excluded from coverage: needs the Obsidian runtime to exercise.
 */
export function obsidianVaultGateway(app: App): VaultGateway {
  const gateway: VaultGateway = {
    getFile(path) {
      const file = app.vault.getAbstractFileByPath(path);
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
      await app.vault.create(path, content);
    },
    async ensureParentFolder(path) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent && !app.vault.getAbstractFileByPath(parent)) {
        await app.vault.createFolder(parent).catch(() => {});
      }
    },
  };
  return gateway;
}
