import type { MemoryDoc } from './pouch';

export interface VaultNote {
  path: string;
  content: string;
  mtime: number;
}

/**
 * Decide which existing vault notes need upserting into the local replica so
 * they replicate up to the cloud. Without this, the vault watcher only catches
 * notes you edit *after* install — a vault full of pre-existing notes would
 * never sync. We seed a note when the replica is missing it entirely, or when
 * the vault holds a strictly newer version (edited while the plugin was off).
 * Notes already matching the replica are skipped; genuine divergence is left
 * for the sync layer's conflict handling to keep both sides of.
 */
export function notesToSeed(
  vaultNotes: VaultNote[],
  replicaDocs: Map<string, MemoryDoc>
): VaultNote[] {
  const out: VaultNote[] = [];
  for (const note of vaultNotes) {
    const doc = replicaDocs.get(note.path);
    if (!doc) {
      out.push(note);
      continue;
    }
    if (doc.content !== note.content && note.mtime > (doc.mtime ?? 0)) {
      out.push(note);
    }
  }
  return out;
}
