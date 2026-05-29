import type { App, TFile } from 'obsidian';
import { getLocalDb, removeNote, upsertNote } from './pouch';
import { describeErr } from './errors';
import type { EchoSuppress } from './echo-suppress';

/**
 * Vault → cloud handlers. Each one consults `echo` first so writes we just
 * applied *from* inbound sync don't bounce right back upstream.
 *
 * Each handler logs and swallows its own errors — replication's `retry: true`
 * will pick up any dropped change on the next pass.
 */

export async function handleNoteChange(app: App, echo: EchoSuppress, file: TFile): Promise<void> {
  if (echo.consume(file.path)) return;
  try {
    const content = await app.vault.read(file);
    await upsertNote(getLocalDb(), file.path, content, file.stat.mtime);
  } catch (err) {
    console.error('[Agentage Memory] auto-upsert failed', file.path, describeErr(err));
  }
}

export async function handleNoteDelete(echo: EchoSuppress, path: string): Promise<void> {
  if (echo.consume(path)) return;
  try {
    await removeNote(getLocalDb(), path);
  } catch (err) {
    console.error('[Agentage Memory] auto-delete failed', path, describeErr(err));
  }
}

/**
 * CouchDB has no native rename — model it as a tombstone on the old `_id` +
 * a fresh upsert at the new path. Other clients see a delete (→ system trash)
 * followed by a create.
 */
export async function handleNoteRename(
  app: App,
  echo: EchoSuppress,
  file: TFile,
  oldPath: string
): Promise<void> {
  if (echo.consume(oldPath)) return;
  try {
    const content = await app.vault.read(file);
    const db = getLocalDb();
    await removeNote(db, oldPath);
    await upsertNote(db, file.path, content, file.stat.mtime);
  } catch (err) {
    console.error(
      '[Agentage Memory] auto-rename failed',
      oldPath,
      '->',
      file.path,
      describeErr(err)
    );
  }
}
