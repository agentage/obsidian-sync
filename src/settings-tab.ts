import { type App, PluginSettingTab, Setting, debounce } from 'obsidian';
import { CONNECT_URL, validateSettings, type AgentageMemorySettings } from './settings';
import type { ApplyResult } from './vaults-config';

// What the settings page needs from the plugin (avoids a circular import on main).
export interface SettingsHost {
  settings: AgentageMemorySettings;
  saveSettings(): Promise<void>;
  vaultRootPath(): string;
  isDesktop: boolean;
  openSignIn(): void;
  isSignedIn(): boolean;
  disconnect(): Promise<void>;
  applyConfig(): Promise<ApplyResult>;
  /** Open the memory chooser popup (pick an existing memory or create a new one). */
  chooseMemory(): void;
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
    const connect = new Setting(containerEl);
    if (this.host.isSignedIn()) {
      connect
        .setName('Connected to Agentage')
        .setDesc('Your account is linked. The sign-in token is stored privately on this device.')
        .addButton((b) =>
          b
            .setWarning()
            .setButtonText('Disconnect')
            .onClick(async () => {
              await this.host.disconnect();
              this.display();
            })
        );
    } else {
      connect
        .setName('Agentage Sync')
        .setDesc('Sign in to start syncing this vault with your Agentage Memory.')
        .addButton((b) =>
          b
            .setCta()
            .setButtonText('Sign in to Agentage')
            .onClick(() => this.host.openSignIn())
        );
    }
    connect.nameEl.addClass('ams-big');

    // ---- Memory (only once signed in): a button that opens the chooser popup ----
    if (this.host.isSignedIn()) {
      const cur = s.vault;
      new Setting(containerEl)
        .setName('Memory')
        .setDesc(cur ? `This vault syncs into "${cur}".` : 'No memory chosen yet.')
        .addButton((b) =>
          b
            .setCta()
            .setButtonText(cur ? 'Change memory…' : 'Choose memory…')
            .onClick(() => this.host.chooseMemory())
        );
    }

    // ---- AI access over MCP (signed-in only; on by default) ----
    if (this.host.isSignedIn()) {
      new Setting(containerEl)
        .setName('Expose remote MCP')
        .setDesc('Let AI apps anywhere — Claude, ChatGPT, Cursor — read and write your notes.')
        .addToggle((t) =>
          t.setValue(s.mcp.includes('remote')).onChange((v) => this.setScope('remote', v))
        );
    }

    this.status = containerEl.createDiv({ cls: 'ams-status' });

    // ---- How to connect AI apps over MCP (only meaningful once signed in) ----
    if (this.host.isSignedIn()) {
      const docs = containerEl.createEl('p', { cls: 'ams-hint' });
      docs.appendText('Connect Claude, ChatGPT, Cursor and more — see ');
      docs.createEl('a', { text: 'how to connect', href: CONNECT_URL });
      docs.appendText('.');
    }
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
