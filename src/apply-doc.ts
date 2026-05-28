import type { EchoSuppress } from './echo-suppress';
import type { MemoryDoc } from './pouch';

/** Opaque handle to a vault file; the concrete type is the gateway's concern. */
export type VaultFile = unknown;

/**
 * The slice of vault operations `applyDocToVault` needs. The Obsidian-backed
 * implementation lives in `obsidian-vault-gateway.ts`; tests pass a fake.
 * Keeping this interface free of any `obsidian` import is what makes the
 * inbound apply logic unit-testable outside the Obsidian runtime.
 */
export interface VaultGateway {
  /** Markdown file at `path`, or null when nothing (or a folder) is there. */
  getFile(path: string): VaultFile | null;
  read(file: VaultFile): Promise<string>;
  modify(file: VaultFile, content: string): Promise<void>;
  trash(file: VaultFile): Promise<void>;
  create(path: string, content: string): Promise<void>;
  /** Create the parent folder for `path` if it's missing (no-op at root). */
  ensureParentFolder(path: string): Promise<void>;
}

/**
 * Apply an inbound CouchDB document to the vault: create / modify the matching
 * .md file or, for a tombstone (`_deleted`), route through the system trash
 * (never a hard wipe). Any write is marked on `echo` so the resulting vault
 * event doesn't bounce the doc straight back upstream.
 */
export async function applyDocToVault(
  vault: VaultGateway,
  doc: MemoryDoc,
  echo: EchoSuppress
): Promise<void> {
  const path = doc._id;
  if (!path) return;
  const existing = vault.getFile(path);

  if (doc._deleted) {
    if (existing) {
      echo.mark(path);
      await vault.trash(existing);
    }
    return;
  }

  const content = doc.content ?? '';
  if (existing) {
    const current = await vault.read(existing);
    if (current === content) return;
    echo.mark(path);
    await vault.modify(existing, content);
    return;
  }

  await vault.ensureParentFolder(path);
  echo.mark(path);
  await vault.create(path, content);
}
