import { type App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import { MCP_ENDPOINT, validateSettings, type AgentageMemorySettings } from './settings';
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
  /** Existing server memories for this account (from the sync host); [] if signed out. */
  listVaults(): Promise<string[]>;
  /** Create a new server memory via the create API, then it becomes syncable. */
  createVault(name: string): Promise<{ ok: boolean; vault?: string; error?: string }>;
  /** Suggested name for a new memory (the normalized Obsidian vault name). */
  defaultVaultName(): string;
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
            .setButtonText('Start sync with agentage')
            .onClick(() => this.host.openSignIn())
        );
    }
    connect.nameEl.addClass('ams-big');

    // ---- Memory picker (only once signed in) — pick an existing memory or create one.
    // Filled async (the list comes from the sync host); the div keeps the row order.
    if (this.host.isSignedIn()) {
      const memEl = containerEl.createDiv();
      void this.renderMemory(memEl);
    }

    // ---- AI access over MCP (on by default) ----
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
  }

  /** Memory section: a dropdown of existing memories (Way 1) + a create row (Way 2). */
  private async renderMemory(host: HTMLElement): Promise<void> {
    host.empty();
    const s = this.host.settings;
    const vaults = await this.host.listVaults();

    const pick = new Setting(host)
      .setName('Memory')
      .setDesc('Which Agentage memory this vault syncs into.');
    pick.addDropdown((d) => {
      if (!vaults.length) d.addOption('', '— none yet, create one below —');
      for (const v of vaults) d.addOption(v, v);
      const cur = vaults.includes(s.vault) ? s.vault : (vaults[0] ?? '');
      if (cur !== s.vault) {
        s.vault = cur;
        void this.host.saveSettings();
      }
      d.setValue(cur).onChange((v) => {
        s.vault = v;
        void this.host.saveSettings();
      });
    });

    // Create a new memory: API create -> empty repo -> first sync is a clean fast-forward.
    let name = this.host.defaultVaultName();
    const create = new Setting(host)
      .setName('Create a new memory')
      .setDesc('Makes a new memory on the server, then syncs this vault into it.');
    create.addText((t) => {
      t.setPlaceholder('my-notes').setValue(name);
      t.inputEl.addClass('ams-mono');
      t.onChange((v) => (name = v));
    });
    create.addButton((b) =>
      b.setButtonText('Create').onClick(async () => {
        b.setDisabled(true).setButtonText('Creating…');
        const res = await this.host.createVault(name);
        if (res.ok && res.vault) {
          s.vault = res.vault;
          await this.host.saveSettings();
          new Notice(`Memory "${res.vault}" ready`);
          await this.renderMemory(host); // refresh the dropdown with the new memory selected
        } else {
          new Notice(`Couldn't create memory: ${res.error ?? 'unknown error'}`);
          b.setDisabled(false).setButtonText('Create');
        }
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
