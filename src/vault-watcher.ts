import { TFile, type App, type EventRef } from 'obsidian';
import { handleNoteChange, handleNoteDelete, handleNoteRename } from './vault-events';
import type { EchoSuppress } from './echo-suppress';

/** Obsidian capabilities the vault watcher needs, injected by the controller. */
export interface VaultWatcherDeps {
  app: App;
  echo: EchoSuppress;
  registerEvent: (ref: EventRef) => void;
  /** Skip `create` until the layout is ready — Obsidian replays one per existing file. */
  isLayoutReady: () => boolean;
}

/**
 * Wire the vault → cloud watchers (modify/create/delete/rename). Obsidian-coupled
 * (touches `app.vault.on`), so coverage-excluded; the per-event logic it calls
 * lives in the dependency-free `vault-events.ts`.
 */
export function registerVaultWatchers({
  app,
  echo,
  registerEvent,
  isLayoutReady,
}: VaultWatcherDeps): void {
  registerEvent(
    app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        void handleNoteChange(app, echo, file);
      }
    })
  );
  registerEvent(
    app.vault.on('create', (file) => {
      if (!isLayoutReady()) return;
      if (file instanceof TFile && file.extension === 'md') {
        void handleNoteChange(app, echo, file);
      }
    })
  );
  registerEvent(
    app.vault.on('delete', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        void handleNoteDelete(echo, file.path);
      }
    })
  );
  registerEvent(
    app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        void handleNoteRename(app, echo, file, oldPath);
      }
    })
  );
}
