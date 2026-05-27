import { Notice, Plugin, TFile, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, type AgentageMemorySettings } from './settings';
import {
  destroyLocalDb,
  pushNoteViaPouch,
  startContinuousSync,
  type PushCreds,
  type ReplicationHandle,
  type SyncChange,
} from './pouch';
import { obsidianFetchForPouch } from './obsidian-fetch';
import { statusDisplay, type StatusState } from './status';
import { createEchoSuppress } from './echo-suppress';
import { applyDocToVault } from './apply-doc';
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

  async onload(): Promise<void> {
    await this.loadSettings();

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

    console.log('[Agentage Memory] loaded');
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
    if (info.direction !== 'pull') return;
    for (const doc of info.docs) {
      void applyDocToVault(this.app, doc, this.echo).catch((err) =>
        console.error('[Agentage Memory] applyDocToVault failed', doc._id, err)
      );
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
