import { type App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import {
  AGENTAGE_REMOTE,
  MCP_ENDPOINT,
  validateSettings,
  type AgentageMemorySettings,
} from './settings';
import type { ApplyResult } from './vaults-config';

// What the settings page needs from the plugin (avoids a circular import on main).
export interface SettingsHost {
  settings: AgentageMemorySettings;
  saveSettings(): Promise<void>;
  vaultRootPath(): string;
  isDesktop: boolean;
  openSignIn(): void;
  applyConfig(): Promise<ApplyResult>;
  setToken(token: string): Promise<void>;
  tokenSet(): boolean;
  syncNow(): Promise<{ ok: boolean; message: string }>;
}

export class AgentageMemorySettingTab extends PluginSettingTab {
  private host: SettingsHost;
  private status?: HTMLElement;
  private writeDebounced: () => void;

  constructor(app: App, host: SettingsHost) {
    super(app, host as unknown as never);
    this.host = host;
    this.writeDebounced = debounce(() => void this.write(), 700, true);
  }

  /** On any change: persist plugin data now, write vaults.json debounced. */
  private touch(): void {
    void this.host.saveSettings();
    this.writeDebounced();
  }

  private async write(): Promise<void> {
    if (validateSettings(this.host.settings).length) return this.setStatus('Not saved yet.', 'err');
    if (!this.host.isDesktop) return this.setStatus('Saved in the app.', 'muted');
    this.setStatus('Saving…', 'muted');
    const res = await this.host.applyConfig();
    this.setStatus(res.ok ? 'Saved' : `Couldn’t save: ${res.error}`, res.ok ? 'ok' : 'err');
  }

  display(): void {
    const { containerEl } = this;
    const s = this.host.settings;
    this.status = undefined;
    containerEl.empty();
    containerEl.addClass('ams-settings');

    containerEl.createEl('p', {
      cls: 'ams-sub',
      text: 'One memory for all your AI — backed up, in sync, and readable by Claude, ChatGPT, Cursor, and more.',
    });

    // ---- Connect (top, primary) ----
    const connected = s.origin.remote.trim() === AGENTAGE_REMOTE;
    const connect = new Setting(containerEl);
    if (connected) {
      connect
        .setName('Connected to Agentage')
        .setDesc('Your account is linked. The sign-in token is stored privately on this device.')
        .addButton((b) =>
          b
            .setWarning()
            .setButtonText('Disconnect')
            .onClick(() => {
              s.origin.remote = '';
              s.syncEnabled = false;
              this.touch();
              this.display();
            })
        );
    } else {
      connect
        .setName('Connect')
        .setDesc('Link your Agentage account to back up and share this memory.')
        .addButton((b) =>
          b
            .setCta()
            .setButtonText('Connect to agentage')
            .onClick(() => {
              s.origin.remote = AGENTAGE_REMOTE;
              s.syncEnabled = true;
              this.host.openSignIn();
              this.touch();
              this.display();
            })
        );
    }
    connect.nameEl.addClass('ams-big');

    // ---- The simple controls ----
    new Setting(containerEl)
      .setName('Setup sync')
      .setDesc(
        s.syncEnabled
          ? 'On — your notes are backed up and synced across your devices.'
          : 'Back up this vault and keep all your devices in sync.'
      )
      .addToggle((t) =>
        t.setValue(s.syncEnabled).onChange((v) => {
          s.syncEnabled = v;
          if (v && !s.origin.remote.trim()) {
            s.origin.remote = AGENTAGE_REMOTE;
            this.host.openSignIn();
          }
          this.touch();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('Expose local MCP')
      .setDesc('Let AI apps on this computer read and write your notes.')
      .addToggle((t) =>
        t.setValue(s.mcp.includes('local')).onChange((v) => this.setScope('local', v))
      );

    new Setting(containerEl)
      .setName('Expose remote MCP')
      .setDesc('Let AI apps anywhere — Claude, ChatGPT, Cursor — read and write your notes.')
      .addToggle((t) =>
        t.setValue(s.mcp.includes('remote')).onChange((v) => this.setScope('remote', v))
      );

    this.status = containerEl.createDiv({ cls: 'ams-status' });

    // ---- Always available: the address to share + the config file ----
    new Setting(containerEl)
      .setName('MCP address')
      .setDesc(
        'Share this with your AI apps. They can read and write once you turn on Expose MCP above.'
      )
      .addText((t) => {
        t.setValue(MCP_ENDPOINT).setDisabled(true);
        t.inputEl.addClass('ams-mono');
        return t;
      })
      .addButton((b) =>
        b.setButtonText('Copy').onClick(async () => {
          await navigator.clipboard.writeText(MCP_ENDPOINT);
          new Notice('MCP address copied');
        })
      );

    new Setting(containerEl)
      .setName('Configuration file')
      .setDesc(
        `${s.configDir}/vaults.json — edit it directly to fine-tune sync (interval, ignored files, a custom git remote). Your edits are kept.`
      )
      .addButton((b) =>
        b.setButtonText('Copy path').onClick(async () => {
          await navigator.clipboard.writeText(`${s.configDir}/vaults.json`);
          new Notice('Path copied');
        })
      );

    this.renderTesting(containerEl, s);
  }

  // Temporary affordance to try sync against any git remote with a token, before the
  // agentage remote resolver + OAuth sign-in land. Desktop only.
  private renderTesting(c: HTMLElement, s: AgentageMemorySettings): void {
    new Setting(c).setName('Sync (testing)').setHeading();
    c.createEl('p', {
      cls: 'ams-sub',
      text: 'Temporary: point at any git remote you can push to (e.g. a GitHub repo) with a token, then Sync now. The agentage remote + sign-in land next. Desktop only.',
    });

    new Setting(c)
      .setName('Git remote (testing)')
      .setDesc('A git URL you can push to, e.g. https://github.com/you/repo.git')
      .addText((t) =>
        t
          .setPlaceholder('https://…/repo.git')
          .setValue(s.origin.remote === 'agentage' ? '' : s.origin.remote)
          .onChange((v) => {
            s.origin.remote = v.trim();
            s.syncEnabled = !!v.trim();
            this.touch();
          })
      );

    new Setting(c)
      .setName('Access token (testing)')
      .setDesc(
        this.host.tokenSet()
          ? 'A token is saved on this device.'
          : 'Paste a token/PAT (stored on this device, never in vaults.json).'
      )
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste token').onChange((v) => void this.host.setToken(v.trim()));
        return t;
      });

    const result = c.createDiv({ cls: 'ams-status' });
    new Setting(c)
      .setName('Sync now')
      .setDesc('Clone or pull, merge, commit local changes, push.')
      .addButton((b) =>
        b
          .setCta()
          .setButtonText('Sync now')
          .onClick(async () => {
            b.setDisabled(true);
            result.empty();
            result.createDiv({ cls: 'ams-status-line ams-muted', text: 'Syncing…' });
            const r = await this.host.syncNow();
            result.empty();
            result.createDiv({
              cls: `ams-status-line ams-${r.ok ? 'ok' : 'err'}`,
              text: r.ok ? `✓ ${r.message}` : r.message,
            });
            new Notice(`Agentage Sync: ${r.message}`);
            b.setDisabled(false);
          })
      );
  }

  /** Add/remove an MCP scope, then persist. */
  private setScope(scope: 'local' | 'remote', on: boolean): void {
    const s = this.host.settings;
    s.mcp = on ? Array.from(new Set([...s.mcp, scope])) : s.mcp.filter((x) => x !== scope);
    this.touch();
  }

  private setStatus(text: string, kind: 'ok' | 'err' | 'muted'): void {
    if (!this.status) return;
    this.status.empty();
    this.status.createDiv({
      cls: `ams-status-line ams-${kind}`,
      text: kind === 'ok' ? `✓ ${text}` : text,
    });
  }
}
