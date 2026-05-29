import { Notice, type App } from 'obsidian';
import { pushNoteViaPouch, type PouchFetch, type PushCreds } from './replication';

/**
 * Push the currently-active markdown note to the cloud, surfacing the outcome
 * as a `Notice`. Obsidian-coupled (active file + toasts), so coverage-excluded
 * and exercised by the E2E suite.
 */
export async function pushActiveNote(
  app: App,
  creds: PushCreds,
  fetchImpl: PouchFetch
): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice('No active note.');
    return;
  }
  if (file.extension !== 'md') {
    new Notice('Active file is not a Markdown note.');
    return;
  }
  const content = await app.vault.read(file);
  try {
    const { id, rev } = await pushNoteViaPouch(
      creds,
      file.path,
      content,
      file.stat.mtime,
      fetchImpl
    );
    new Notice(`Pushed: ${id} (rev ${rev.split('-')[0]})`);
  } catch (err) {
    new Notice(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
