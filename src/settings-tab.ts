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
  private preview!: HTMLElement;
  private status!: HTMLElement;
  private errors!: HTMLElement;
  private writeDebounced: () => void;

  constructor(app: App, host: SettingsHost) {
    super(app, host as unknown as never);
    this.host = host;
    this.writeDebounced = debounce(() => void this.write(), 700, true);
  }

  /** On any change: persist plugin data + refresh the preview now, write vaults.json debounced. */
  private touch(): void {
    void this.host.saveSettings();
    this.refreshPreview();
    this.writeDebounced();
  }

  private async write(): Promise<void> {
    const errs = validateSettings(this.host.settings);
    if (errs.length) return this.setStatus('Not written — resolve the warnings above.', 'err');
    if (!this.host.isDesktop) return this.setStatus('Saved in-app. Writing ~/.agentage/vaults.json needs the desktop app.', 'muted');
    this.setStatus('Saving…', 'muted');
    const res = await this.host.applyConfig();
    this.setStatus(res.ok ? `Saved to ${res.path}` : `Write failed: ${res.error}`, res.ok ? 'ok' : 'err');
  }

  display(): void {
    const { containerEl } = this;
    const s = this.host.settings;
    containerEl.empty();
    containerEl.addClass('ams-settings');

    containerEl.createEl('h2', { text: 'Agentage Memory Sync' });
    containerEl.createEl('p', { cls: 'ams-sub', text: 'One memory. Every AI. Owned by you.' });

    this.renderAccount(containerEl, s);

    // ---- Capabilities ----
    containerEl.createEl('h3', { text: 'Capabilities' });

    new Setting(containerEl)
      .setName('Sync via git')
      .setDesc('Two-way git sync of this vault. Uses the agentage remote (Connect) or a custom git URL in Advanced.')
      .addToggle((t) =>
        t.setValue(s.syncEnabled).onChange((v) => {
          s.syncEnabled = v;
          this.touch();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('Expose as MCP')
      .setDesc('Let Claude, ChatGPT, and Cursor read and write this memory over MCP.')
      .addToggle((t) =>
        t.setValue(s.mcp.length > 0).onChange((v) => {
          s.mcp = v ? (s.mcp.length ? s.mcp : ['local']) : [];
          this.touch();
          this.display();
        })
      );

    if (s.mcp.length > 0) {
      new Setting(containerEl)
        .setName('Also expose remote scope')
        .setDesc('Expose the cloud copy too (in addition to the local working copy).')
        .addToggle((t) =>
          t.setValue(s.mcp.includes('remote')).onChange((v) => {
            s.mcp = v ? Array.from(new Set([...s.mcp, 'remote'])) : s.mcp.filter((x) => x !== 'remote');
            this.touch();
          })
        );
      new Setting(containerEl)
        .setName('MCP endpoint')
        .setDesc('Connect your AI clients to this URL.')
        .addText((t) => { t.setValue(MCP_ENDPOINT).setDisabled(true); t.inputEl.addClass('ams-mono'); return t; })
        .addButton((b) => b.setButtonText('Copy').onClick(async () => { await navigator.clipboard.writeText(MCP_ENDPOINT); new Notice('MCP endpoint copied'); }));
    }

    new Setting(containerEl)
      .setName('Set as default vault')
      .setDesc('The vault every AI sees first.')
      .addToggle((t) => t.setValue(s.makeDefault).onChange((v) => { s.makeDefault = v; this.touch(); }));

    new Setting(containerEl)
      .setName('Advanced settings')
      .setDesc('Vault name, paths, custom remote, interval, ignore.')
      .addToggle((t) => t.setValue(s.showAdvanced).onChange((v) => { s.showAdvanced = v; void this.host.saveSettings(); this.display(); }));

    if (s.showAdvanced) this.renderAdvanced(containerEl, s);

    // ---- Saved configuration ----
    containerEl.createEl('h3', { text: 'Saved configuration' });
    containerEl.createEl('p', { cls: 'ams-sub', text: `Written to ${s.configDir}/vaults.json — the config memory-core loads.` });
    this.errors = containerEl.createDiv({ cls: 'ams-errors' });
    this.status = containerEl.createDiv({ cls: 'ams-status' });
    this.preview = containerEl.createEl('pre', { cls: 'ams-preview' });
    this.refreshPreview();
  }

  private renderAccount(c: HTMLElement, s: AgentageMemorySettings): void {
    const remote = s.origin.remote.trim();
    const acct = new Setting(c).setName('agentage account');
    if (remote === AGENTAGE_REMOTE) {
      acct
        .setDesc('Connected to the agentage remote. Your token is saved in ~/.agentage/auth.json (never in vaults.json).')
        .addButton((b) =>
          b.setButtonText('Disconnect').setWarning().onClick(() => {
            s.origin.remote = '';
            s.syncEnabled = false;
            this.touch();
            this.display();
          })
        );
    } else {
      const connect = () => {
        s.origin.remote = AGENTAGE_REMOTE;
        s.syncEnabled = true;
        this.host.openSignIn();
        this.touch();
        this.display();
      };
      if (remote) acct.setDesc('Using a custom git remote (see Advanced). Switch to the managed agentage remote anytime.');
      else acct.setDesc('Sign in once; every AI shares this memory.');
      acct.addButton((b) => b.setButtonText(remote ? 'Use agentage' : 'Connect to agentage').setCta().onClick(connect));
    }
  }

  private renderAdvanced(c: HTMLElement, s: AgentageMemorySettings): void {
    c.createEl('h3', { text: 'Advanced' });

    new Setting(c)
      .setName('Vault name')
      .setDesc('Key in vaults.json (lowercase, a-z 0-9 - _).')
      .addText((t) => t.setPlaceholder('personal').setValue(s.vaultName).onChange((v) => { s.vaultName = v; this.touch(); }));

    new Setting(c)
      .setName('Local path')
      .setDesc('Working-copy folder. Blank = this vault’s folder.')
      .addText((t) => t.setPlaceholder(this.host.vaultRootPath()).setValue(s.path).onChange((v) => { s.path = v; this.touch(); }));

    new Setting(c)
      .setName('Config directory')
      .setDesc('Where vaults.json lives.')
      .addText((t) => t.setValue(s.configDir).onChange((v) => { s.configDir = v.trim() || '~/.agentage'; this.touch(); }));

    if (s.syncEnabled) {
      new Setting(c)
        .setName('Remote')
        .setDesc('“agentage” (managed) or any git URL.')
        .addText((t) => {
          t.setPlaceholder(`agentage  ·  ${DEFAULT_REMOTE_HOST}/<user>/<vault>.git`).setValue(s.origin.remote).onChange((v) => { s.origin.remote = v; this.touch(); });
          t.inputEl.addClass('ams-mono');
          return t;
        });
      new Setting(c)
        .setName('Sync interval (minutes)')
        .setDesc('Background pull/push cadence. 0 = manual only.')
        .addText((t) => t.setValue(String(s.origin.interval)).onChange((v) => { const n = Number.parseInt(v, 10); s.origin.interval = Number.isFinite(n) && n >= 0 ? n : 0; this.touch(); }));
      new Setting(c)
        .setName('Ignore')
        .setDesc('Comma/newline globs kept out of the repo.')
        .addTextArea((t) => t.setPlaceholder('.obsidian, .trash').setValue(s.origin.ignore.join(', ')).onChange((v) => { s.origin.ignore = parseIgnore(v); this.touch(); }));
    }
  }

  private setStatus(text: string, kind: 'ok' | 'err' | 'muted'): void {
    if (!this.status) return;
    this.status.empty();
    this.status.createDiv({ cls: `ams-status-line ams-${kind}`, text: kind === 'ok' ? `✓ ${text}` : text });
  }

  private refreshPreview(): void {
    if (!this.preview) return;
    const s = this.host.settings;
    this.preview.setText(JSON.stringify(buildVaultsConfig(s, this.host.vaultRootPath()), null, 2));
    this.errors.empty();
    for (const e of validateSettings(s)) this.errors.createDiv({ cls: 'ams-error', text: `⚠ ${e}` });
    const normalized = normalizeVaultName(s.vaultName);
    if (normalized && normalized !== s.vaultName.trim()) this.errors.createDiv({ cls: 'ams-hint', text: `Saved as “${normalized}”.` });
  }
}
