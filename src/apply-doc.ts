import { TFile, type App } from 'obsidian';
import type { EchoSuppress } from './echo-suppress';
import type { MemoryDoc } from './pouch';

/**
 * Apply an inbound CouchDB document to the Obsidian vault: create / modify
 * the matching .md file or, for a tombstone (`_deleted`), route through the
 * system trash (never a hard wipe). Any write we perform is marked on `echo`
 * so the resulting vault event doesn't bounce the doc straight back.
 */
export async function applyDocToVault(app: App, doc: MemoryDoc, echo: EchoSuppress): Promise<void> {
  const path = doc._id;
  if (!path) return;
  const existing = app.vault.getAbstractFileByPath(path);

  if (doc._deleted) {
    if (existing instanceof TFile) {
      echo.mark(path);
      await app.vault.trash(existing, true);
    }
    return;
  }

  const content = doc.content ?? '';
  if (existing instanceof TFile) {
    const current = await app.vault.read(existing);
    if (current === content) return;
    echo.mark(path);
    await app.vault.modify(existing, content);
    return;
  }

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (parent && !app.vault.getAbstractFileByPath(parent)) {
    await app.vault.createFolder(parent).catch(() => {});
  }
  echo.mark(path);
  await app.vault.create(path, content);
}
