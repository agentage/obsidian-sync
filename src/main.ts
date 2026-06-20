import { FileSystemAdapter, Notice, Platform, Plugin } from 'obsidian';
import { AgentageMemorySettings, DEFAULT_SETTINGS, normalizeVaultName } from './settings';
import { AgentageMemorySettingTab, SettingsHost } from './settings-tab';
import { applyVaultsConfig, type ApplyResult } from './vaults-config';

const CONNECT_URL = 'https://agentage.io';

// Configuration page for Agentage Sync. Writes the memory-core config
// (~/.agentage/vaults.json); the sync engine + MCP wiring land in later milestones.
export default class AgentageMemoryPlugin extends Plugin implements SettingsHost {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;
  isDesktop = Platform.isDesktopApp;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AgentageMemorySettingTab(this.app, this));
    this.addStatusBarItem().setText('Agentage Sync');
  }

  /** Absolute path of this vault's folder (desktop); falls back to the vault name. */
  vaultRootPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
  }

  /** memory-core vault name: the user's override, else this Obsidian vault's name. */
  private vaultName(): string {
    return normalizeVaultName(this.settings.vaultName) || normalizeVaultName(this.app.vault.getName()) || 'personal';
  }

  openSignIn(): void {
    window.open(CONNECT_URL, '_blank');
    new Notice('Opening agentage sign-in. Your token will be saved to ~/.agentage/auth.json (not vaults.json) when sign-in lands.');
  }

  /** Upsert this vault into ~/.agentage/vaults.json, preserving hand-edits + CLI vaults. */
  async applyConfig(): Promise<ApplyResult> {
    const s = this.settings;
    const name = this.vaultName();
    const res = await applyVaultsConfig({
      configDirSetting: s.configDir,
      name,
      previousName: s.writtenVaultName || undefined,
      makeDefault: s.makeDefault,
      path: s.path.trim() || this.vaultRootPath(),
      syncEnabled: s.syncEnabled,
      remote: s.origin.remote,
      mcp: s.mcp,
    });
    if (res.ok) {
      s.writtenVaultName = name;
      await this.saveSettings();
    }
    return res;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<AgentageMemorySettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
    this.settings.origin = { ...DEFAULT_SETTINGS.origin, ...this.settings.origin };
    if (!Array.isArray(this.settings.mcp)) this.settings.mcp = [...DEFAULT_SETTINGS.mcp];
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
