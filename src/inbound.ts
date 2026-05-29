/**
 * Inbound apply + seed logic. Obsidian-free (takes a `VaultGateway` + a local
 * PouchDB), so it's unit-testable outside the Obsidian runtime. The controller
 * supplies the live DB/gateway and owns error logging; these functions throw.
 */
import { getAllLocalDocs, resolveConflictedDoc, upsertNote, type LocalDb } from './pouch';
import { applyDocToVault, type VaultGateway } from './apply-doc';
import { conflictSidecarPath } from './conflict';
import { notesToSeed } from './seed';
import type { EchoSuppress } from './echo-suppress';

/**
 * Apply a pulled doc to the vault by its *winning* revision (read from the
 * local replica), never the change-feed body — under a conflict that body can
 * be the loser. Concurrent-edit losers are preserved as sidecar notes (locked
 * rule #3: keep both), created *without* echo suppression so the watcher
 * pushes them upstream — every device ends up with both edits.
 */
export async function applyPulledDoc(
  db: LocalDb,
  gateway: VaultGateway,
  echo: EchoSuppress,
  id: string
): Promise<void> {
  const { deleted, content, losers } = await resolveConflictedDoc(db, id);
  await applyDocToVault(
    gateway,
    deleted ? { _id: id, _deleted: true } : { _id: id, content },
    echo
  );
  for (const loser of losers) {
    const path = conflictSidecarPath(id, loser.rev);
    if (!gateway.getFile(path)) {
      await gateway.create(path, loser.content);
    }
  }
}

/**
 * Seed pre-existing vault notes into the local replica so they replicate up.
 * The watcher's `create` events are skipped on load (Obsidian replays one per
 * existing file), so without this an already-populated vault would never reach
 * the cloud. Only missing/newer notes are upserted — cheap and idempotent on
 * every launch. Returns the number of notes seeded.
 */
export async function seedLocalReplica(db: LocalDb, gateway: VaultGateway): Promise<number> {
  const notes = await gateway.listNotes();
  const todo = notesToSeed(notes, await getAllLocalDocs(db));
  for (const note of todo) {
    await upsertNote(db, note.path, note.content, note.mtime);
  }
  return todo.length;
}
