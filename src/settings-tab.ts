import { App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import {
  AGENTAGE_REMOTE,
  DEFAULT_REMOTE_HOST,
  MCP_ENDPOINT,
  buildVaultsConfig,
  normalizeVaultName,
  parseIgnore,
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
}

export class AgentageMemorySettingTab extends PluginSettingTab {
  private host: SettingsHost;
  private status?: HTMLElement;
  private preview?: HTMLElement;
  private errors?: HTMLElement;
  private writeDebounced: () => void;

  constructor(app: App, host: SettingsHost) {
    super(app, host as unknown as never);
    this.host = host;
    this.writeDebounced = debounce(() => void this.write(), 700, true);
  }

  /** On any change: persist plugin data + refresh now, write vaults.json debounced. */
  private touch(): void {
    void this.host.saveSettings();
    this.refreshPreview();
    this.writeDebounced();
  }

  private async write(): Promise<void> {
    if (validateSettings(this.host.settings).length) return this.setStatus('Not saved yet — check Advanced settings.', 'err');
    if (!this.host.isDesktop) return this.setStatus('Saved in the app.', 'muted');
    this.setStatus('Saving…', 'muted');
    const res = await this.host.applyConfig();
    this.setStatus(res.ok ? 'Saved' : `Couldn’t save: ${res.error}`, res.ok ? 'ok' : 'err');
  }

  display(): void {
    const { containerEl } = this;
    const s = this.host.settings;
    this.preview = this.errors = this.status = undefined;
    containerEl.empty();
    containerEl.addClass('ams-settings');

    containerEl.createEl('h2', { text: 'Agentage Sync' });
    containerEl.createEl('p', {
      cls: 'ams-sub',
      text: 'One memory for all your AI — backed up, in sync, and readable by Claude, ChatGPT, Cursor, and more.',
    });

    // ---- The three simple controls ----
    const setup = new Setting(containerEl)
      .setName('Setup sync')
      .setDesc(
        s.syncEnabled
          ? s.origin.remote.trim() === AGENTAGE_REMOTE
            ? 'On — backed up to your Agentage account and synced across your devices.'
            : 'On — syncing with a custom remote (see Advanced).'
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
    setup.nameEl.addClass('ams-big');

    new Setting(containerEl)
      .setName('Expose local MCP')
      .setDesc('Let AI apps on this computer read and write your notes.')
      .addToggle((t) => t.setValue(s.mcp.includes('local')).onChange((v) => { this.setScope('local', v); this.display(); }));

    new Setting(containerEl)
      .setName('Expose remote MCP')
      .setDesc('Let AI apps anywhere — Claude, ChatGPT, Cursor — read and write your notes.')
      .addToggle((t) => t.setValue(s.mcp.includes('remote')).onChange((v) => { this.setScope('remote', v); this.display(); }));

    if (s.mcp.length > 0) {
      new Setting(containerEl)
        .setName('Your AI connection')
        .setDesc('Paste this address into Claude, ChatGPT, or Cursor to connect them to your memory.')
        .addText((t) => { t.setValue(MCP_ENDPOINT).setDisabled(true); t.inputEl.addClass('ams-mono'); return t; })
        .addButton((b) => b.setCta().setButtonText('Copy').onClick(async () => { await navigator.clipboard.writeText(MCP_ENDPOINT); new Notice('Copied — paste it into your AI app'); }));
    }

    this.status = containerEl.createDiv({ cls: 'ams-status' });

    // ---- Advanced (hidden complexity) ----
    new Setting(containerEl)
      .setName('Advanced settings')
      .setDesc('For power users: account, custom remote, paths, MCP details.')
      .addToggle((t) => t.setValue(s.showAdvanced).onChange((v) => { s.showAdvanced = v; void this.host.saveSettings(); this.display(); }));

    if (s.showAdvanced) this.renderAdvanced(containerEl, s);

    this.refreshPreview();
  }

  /** Add/remove an MCP scope, then persist. */
  private setScope(scope: 'local' | 'remote', on: boolean): void {
    const s = this.host.settings;
    s.mcp = on ? Array.from(new Set([...s.mcp, scope])) : s.mcp.filter((x) => x !== scope);
    this.touch();
  }

  private renderAdvanced(c: HTMLElement, s: AgentageMemorySettings): void {
    c.createEl('h3', { text: 'Account' });
    const remote = s.origin.remote.trim();
    const acct = new Setting(c).setName('agentage account');
    if (remote === AGENTAGE_REMOTE) {
      acct
        .setDesc('Connected. Your token is stored in ~/.agentage/auth.json (never in vaults.json).')
        .addButton((b) => b.setWarning().setButtonText('Disconnect').onClick(() => { s.origin.remote = ''; s.syncEnabled = false; this.touch(); this.display(); }));
    } else {
      acct
        .setDesc(remote ? 'Using a custom git remote (below).' : 'Not connected.')
        .addButton((b) => b.setCta().setButtonText(remote ? 'Use agentage' : 'Connect to agentage').onClick(() => { s.origin.remote = AGENTAGE_REMOTE; s.syncEnabled = true; this.host.openSignIn(); this.touch(); this.display(); }));
    }

    c.createEl('h3', { text: 'Vault' });
    new Setting(c).setName('Vault name').setDesc('Key in vaults.json (a-z 0-9 - _).')
      .addText((t) => t.setPlaceholder('personal').setValue(s.vaultName).onChange((v) => { s.vaultName = v; this.touch(); }));
    new Setting(c).setName('Local path').setDesc('Working-copy folder. Blank = this vault’s folder.')
      .addText((t) => t.setPlaceholder(this.host.vaultRootPath()).setValue(s.path).onChange((v) => { s.path = v; this.touch(); }));
    new Setting(c).setName('Config directory').setDesc('Where vaults.json lives.')
      .addText((t) => t.setValue(s.configDir).onChange((v) => { s.configDir = v.trim() || '~/.agentage'; this.touch(); }));
    new Setting(c).setName('Set as default vault').setDesc('The vault every AI sees first.')
      .addToggle((t) => t.setValue(s.makeDefault).onChange((v) => { s.makeDefault = v; this.touch(); }));

    if (s.syncEnabled) {
      c.createEl('h3', { text: 'Sync' });
      new Setting(c).setName('Remote').setDesc('“agentage” (managed) or any git URL.')
        .addText((t) => { t.setPlaceholder(`agentage  ·  ${DEFAULT_REMOTE_HOST}/<user>/<vault>.git`).setValue(s.origin.remote).onChange((v) => { s.origin.remote = v; this.touch(); }); t.inputEl.addClass('ams-mono'); return t; });
      new Setting(c).setName('Sync interval (minutes)').setDesc('Background cadence. 0 = manual only.')
        .addText((t) => t.setValue(String(s.origin.interval)).onChange((v) => { const n = Number.parseInt(v, 10); s.origin.interval = Number.isFinite(n) && n >= 0 ? n : 0; this.touch(); }));
      new Setting(c).setName('Ignore').setDesc('Comma/newline globs kept out of the repo.')
        .addTextArea((t) => t.setPlaceholder('.obsidian, .trash').setValue(s.origin.ignore.join(', ')).onChange((v) => { s.origin.ignore = parseIgnore(v); this.touch(); }));
    }

    c.createEl('h3', { text: 'Saved configuration' });
    c.createEl('p', { cls: 'ams-sub', text: `Written to ${s.configDir}/vaults.json — the config memory-core loads.` });
    this.errors = c.createDiv({ cls: 'ams-errors' });
    this.preview = c.createEl('pre', { cls: 'ams-preview' });
  }

  private setStatus(text: string, kind: 'ok' | 'err' | 'muted'): void {
    if (!this.status) return;
    this.status.empty();
    this.status.createDiv({ cls: `ams-status-line ams-${kind}`, text: kind === 'ok' ? `✓ ${text}` : text });
  }

  private refreshPreview(): void {
    const s = this.host.settings;
    if (this.preview) this.preview.setText(JSON.stringify(buildVaultsConfig(s, this.host.vaultRootPath()), null, 2));
    if (this.errors) {
      this.errors.empty();
      for (const e of validateSettings(s)) this.errors.createDiv({ cls: 'ams-error', text: `⚠ ${e}` });
      const norm = normalizeVaultName(s.vaultName);
      if (norm && norm !== s.vaultName.trim()) this.errors.createDiv({ cls: 'ams-hint', text: `Saved as “${norm}”.` });
    }
  }
}
