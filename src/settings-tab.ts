import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import {
  AgentageMemorySettings,
  DEFAULT_REMOTE_HOST,
  MCP_ENDPOINT,
  McpScope,
  buildVaultsConfig,
  normalizeVaultName,
  parseIgnore,
  validateSettings,
} from './settings';

// What the settings page needs from the plugin (avoids a circular import on main).
export interface SettingsHost {
  settings: AgentageMemorySettings;
  saveSettings(): Promise<void>;
  vaultRootPath(): string;
}

export class AgentageMemorySettingTab extends PluginSettingTab {
  private host: SettingsHost;
  private preview!: HTMLElement;
  private errors!: HTMLElement;

  constructor(app: App, host: SettingsHost) {
    super(app, host as unknown as never);
    this.host = host;
  }

  private save(): void {
    void this.host.saveSettings();
    this.refreshPreview();
  }

  display(): void {
    const { containerEl } = this;
    const s = this.host.settings;
    containerEl.empty();
    containerEl.addClass('ams-settings');

    containerEl.createEl('h2', { text: 'Agentage Memory Sync' });
    containerEl.createEl('p', {
      cls: 'ams-sub',
      text: 'One memory. Every AI. Owned by you. Configure how this vault maps to your agentage Memory.',
    });
    const callout = containerEl.createDiv({ cls: 'ams-callout' });
    callout.createSpan({ cls: 'ams-callout-tag', text: 'Configuration only' });
    callout.createSpan({
      text: ' — the sync engine is being built. These settings define your memory-core vaults.json.',
    });

    // ---- 1 · Pick repo (vault) ----
    containerEl.createEl('h3', { text: '1 · Pick repo (vault)' });

    new Setting(containerEl)
      .setName('Vault name')
      .setDesc('The name of this memory in vaults.json (lowercase, a-z 0-9 - _).')
      .addText((t) =>
        t
          .setPlaceholder('personal')
          .setValue(s.vaultName)
          .onChange((v) => {
            s.vaultName = v;
            this.save();
          })
      );

    new Setting(containerEl)
      .setName('Local path')
      .setDesc('Folder kept as the git working copy. Leave blank to use this vault’s folder.')
      .addText((t) =>
        t
          .setPlaceholder(this.host.vaultRootPath())
          .setValue(s.path)
          .onChange((v) => {
            s.path = v;
            this.save();
          })
      );

    new Setting(containerEl)
      .setName('Set as default vault')
      .setDesc('Make this the `default` vault every AI sees first.')
      .addToggle((t) =>
        t.setValue(s.makeDefault).onChange((v) => {
          s.makeDefault = v;
          this.save();
        })
      );

    // ---- 2 · Setup sync (origin) ----
    containerEl.createEl('h3', { text: '2 · Setup sync' });

    new Setting(containerEl)
      .setName('Enable sync')
      .setDesc('Two-way git sync to the remote. Sign-in + the sync engine arrive with the rebuild.')
      .addToggle((t) =>
        t.setValue(s.syncEnabled).onChange((v) => {
          s.syncEnabled = v;
          this.save();
          this.display();
        })
      );

    if (s.syncEnabled) {
      new Setting(containerEl)
        .setName('Remote URL')
        .setDesc('Your per-vault git remote.')
        .addText((t) =>
          t
            .setPlaceholder(`${DEFAULT_REMOTE_HOST}/<user>/<vault>.git`)
            .setValue(s.origin.remote)
            .onChange((v) => {
              s.origin.remote = v;
              this.save();
            })
        );

      new Setting(containerEl)
        .setName('Sync interval (minutes)')
        .setDesc('How often to pull/push in the background. 0 = manual only.')
        .addText((t) =>
          t.setValue(String(s.origin.interval)).onChange((v) => {
            const n = Number.parseInt(v, 10);
            s.origin.interval = Number.isFinite(n) && n >= 0 ? n : 0;
            this.save();
          })
        );

      new Setting(containerEl)
        .setName('Ignore')
        .setDesc('Comma- or newline-separated globs kept out of the synced repo.')
        .addTextArea((t) =>
          t
            .setPlaceholder('.obsidian, .trash')
            .setValue(s.origin.ignore.join(', '))
            .onChange((v) => {
              s.origin.ignore = parseIgnore(v);
              this.save();
            })
        );
    }

    // ---- 3 · Expose as MCP ----
    containerEl.createEl('h3', { text: '3 · Expose as MCP' });

    const scopeToggle = (scope: McpScope, name: string, desc: string) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(s.mcp.includes(scope)).onChange((v) => {
            s.mcp = v ? Array.from(new Set([...s.mcp, scope])) : s.mcp.filter((x) => x !== scope);
            this.save();
          })
        );

    scopeToggle('local', 'Local scope', 'Expose this vault’s local working copy over MCP.');
    scopeToggle('remote', 'Remote scope', 'Expose the cloud copy over MCP (after sync is connected).');

    new Setting(containerEl)
      .setName('MCP endpoint')
      .setDesc('Connect Claude, ChatGPT, or Cursor to this URL to read and write the same memory.')
      .addText((t) => {
        t.setValue(MCP_ENDPOINT).setDisabled(true);
        t.inputEl.addClass('ams-mono');
        return t;
      })
      .addButton((b) =>
        b
          .setButtonText('Copy')
          .setCta()
          .onClick(async () => {
            await navigator.clipboard.writeText(MCP_ENDPOINT);
            new Notice('MCP endpoint copied');
          })
      );

    // ---- vaults.json preview ----
    containerEl.createEl('h3', { text: 'vaults.json preview' });
    containerEl.createEl('p', {
      cls: 'ams-sub',
      text: `Written to ${s.configDir}/vaults.json — the config memory-core loads and validates.`,
    });
    this.errors = containerEl.createDiv({ cls: 'ams-errors' });
    this.preview = containerEl.createEl('pre', { cls: 'ams-preview' });
    this.refreshPreview();
  }

  private refreshPreview(): void {
    if (!this.preview) return;
    const s = this.host.settings;
    this.preview.setText(JSON.stringify(buildVaultsConfig(s, this.host.vaultRootPath()), null, 2));
    const errs = validateSettings(s);
    this.errors.empty();
    for (const e of errs) this.errors.createDiv({ cls: 'ams-error', text: `⚠ ${e}` });
    // reflect the normalized name back so the user sees what gets written
    const normalized = normalizeVaultName(s.vaultName);
    if (normalized && normalized !== s.vaultName.trim()) {
      this.errors.createDiv({ cls: 'ams-hint', text: `Saved as “${normalized}”.` });
    }
  }
}
