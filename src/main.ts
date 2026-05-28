import { Notice, Plugin, TFile, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, type AgentageMemorySettings } from './settings';
import {
  destroyLocalDb,
  getAllLocalDocs,
  getLocalDb,
  pushNoteViaPouch,
  resolveConflictedDoc,
  startContinuousSync,
  upsertNote,
  type PushCreds,
  type ReplicationHandle,
  type SyncChange,
} from './pouch';
import { obsidianFetchForPouch } from './obsidian-fetch';
import { statusDisplay, type StatusState } from './status';
import { createEchoSuppress } from './echo-suppress';
import { applyDocToVault, type VaultGateway } from './apply-doc';
import { obsidianVaultGateway } from './obsidian-vault-gateway';
import { notesToSeed } from './seed';
import { conflictSidecarPath } from './conflict';
import { AgentageMemorySettingTab } from './settings-tab';
import { describeErr } from './errors';
import { handleNoteChange, handleNoteDelete, handleNoteRename } from './vault-events';

const RIBBON_ICON = 'refresh-cw';

// Obsidian loads the entry plugin class as the module's DEFAULT export. This
// is the one place we use a default export; everything else uses named exports.
export default class AgentageMemoryPlugin extends Plugin {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;
  private replication: ReplicationHandle | null = null;
  private statusBar: HTMLElement | null = null;
  private readonly echo = createEchoSuppress();
  private gateway: VaultGateway | null = null;
  private layoutReady = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.gateway = obsidianVaultGateway(this.app);
    this.statusBar = this.addStatusBarItem();
    this.setStatus('idle');

    this.addRibbonIcon(
      RIBBON_ICON,
      'Agentage Memory',
      () =>
        new Notice('Agentage Memory: edits auto-sync; use the command palette to push manually.')
    );

    this.addCommand({
      id: 'push-current-note',
      name: 'Push current note to Agentage Memory',
      callback: async () => {
        await this.pushCurrentNote();
      },
    });

    this.addSettingTab(new AgentageMemorySettingTab(this.app, this));

    this.registerVaultEvents();
    this.startReplication();

    // Obsidian replays a `create` event for every existing file on vault load.
    // We skip that storm (see registerVaultEvents) and instead seed once the
    // layout is ready — only pushing notes the replica is missing or stale on,
    // rather than re-putting the whole vault on every launch.
    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      void this.seedVault();
    });

    console.log('[Agentage Memory] loaded');
  }

  /**
   * Push pre-existing vault notes into the local replica so they replicate up.
   * The vault watcher's `create` events are ignored on load (Obsidian fires one
   * per existing file), so without this an already-populated vault — or one
   * enabled after startup — would never reach the cloud. Only missing/newer
   * notes are upserted, so re-running on each launch is cheap and idempotent.
   */
  private async seedVault(): Promise<void> {
    if (!this.gateway) return;
    try {
      const db = getLocalDb();
      const notes = await this.gateway.listNotes();
      const todo = notesToSeed(notes, await getAllLocalDocs(db));
      for (const note of todo) {
        await upsertNote(db, note.path, note.content, note.mtime);
      }
      if (todo.length) {
        console.log(`[Agentage Memory] seeded ${todo.length} existing note(s) to local replica`);
      }
    } catch (err) {
      console.error('[Agentage Memory] seedVault failed:', describeErr(err));
    }
  }

  async onunload(): Promise<void> {
    this.stopReplication();
    await destroyLocalDb().catch((err) => console.warn('[Agentage Memory] destroyLocalDb', err));
    console.log('[Agentage Memory] unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private creds(): PushCreds {
    return {
      serverUrl: this.settings.serverUrl,
      username: this.settings.username,
      password: this.settings.password,
      dbName: this.settings.dbName,
    };
  }

  private setStatus(state: StatusState, detail?: string): void {
    if (!this.statusBar) return;
    const { iconId, tooltip, color } = statusDisplay(state, detail);
    this.statusBar.empty();
    const iconEl = this.statusBar.createSpan({ cls: 'agentage-memory-status-icon' });
    iconEl.dataset.status = state;
    iconEl.style.color = color;
    setIcon(iconEl, iconId);
    this.statusBar.title = tooltip;
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          void handleNoteChange(this.app, this.echo, file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        // Obsidian replays `create` for every existing file on vault load.
        // Skip that storm — `seedVault` handles pre-existing notes once.
        if (!this.layoutReady) return;
        if (file instanceof TFile && file.extension === 'md') {
          void handleNoteChange(this.app, this.echo, file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          void handleNoteDelete(this.echo, file.path);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          void handleNoteRename(this.app, this.echo, file, oldPath);
        }
      })
    );
  }

  startReplication(): void {
    this.stopReplication();
    try {
      this.replication = startContinuousSync(this.creds(), obsidianFetchForPouch(this.creds()), {
        onActive: () => this.setStatus('active'),
        onPaused: (err) => {
          if (err) {
            console.warn('[Agentage Memory] paused with transient error:', describeErr(err));
          }
          this.setStatus('synced');
        },
        onChange: (info: SyncChange) => this.onSyncChange(info),
        onError: (err) => {
          console.error('[Agentage Memory] replication terminated:', describeErr(err));
          this.setStatus('error');
        },
      });
    } catch (err) {
      console.error('[Agentage Memory] startReplication failed:', describeErr(err));
      this.setStatus('error');
    }
  }

  private onSyncChange(info: SyncChange): void {
    console.log(
      '[Agentage Memory] sync',
      info.direction,
      `read=${info.docsRead} written=${info.docsWritten}`
    );
    if (info.direction !== 'pull' || !this.gateway) return;
    const gateway = this.gateway;
    for (const doc of info.docs) {
      void this.applyPulledDoc(gateway, doc._id);
    }
  }

  /**
   * Apply a pulled doc to the vault by its *winning* revision (read from the
   * local replica), never the change-feed body — under a conflict that body
   * can be the loser. Concurrent-edit losers are preserved as sidecar notes
   * (locked rule #3: keep both), created *without* echo suppression so the
   * watcher pushes them upstream — every device ends up with both edits.
   */
  private async applyPulledDoc(gateway: VaultGateway, id: string): Promise<void> {
    try {
      const { deleted, content, losers } = await resolveConflictedDoc(getLocalDb(), id);
      await applyDocToVault(
        gateway,
        deleted ? { _id: id, _deleted: true } : { _id: id, content },
        this.echo
      );
      for (const loser of losers) {
        const path = conflictSidecarPath(id, loser.rev);
        if (!gateway.getFile(path)) {
          await gateway.create(path, loser.content);
        }
      }
    } catch (err) {
      console.error('[Agentage Memory] applyPulledDoc failed', id, err);
    }
  }

  stopReplication(): void {
    if (this.replication) {
      this.replication.cancel();
      this.replication = null;
    }
  }

  async pushCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('No active note.');
      return;
    }
    if (file.extension !== 'md') {
      new Notice('Active file is not a Markdown note.');
      return;
    }
    const content = await this.app.vault.read(file);
    try {
      const { id, rev } = await pushNoteViaPouch(
        this.creds(),
        file.path,
        content,
        file.stat.mtime,
        obsidianFetchForPouch(this.creds())
      );
      const shortRev = rev.split('-')[0];
      new Notice(`Pushed: ${id} (rev ${shortRev})`);
    } catch (err) {
      new Notice(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
