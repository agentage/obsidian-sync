import { FileSystemAdapter, Plugin } from 'obsidian';
import { AgentageMemorySettings, DEFAULT_SETTINGS } from './settings';
import { AgentageMemorySettingTab, SettingsHost } from './settings-tab';

// Configuration-only build: registers the settings page and persists config.
// The sync engine (git smart-HTTP) and MCP wiring land in later milestones.
export default class AgentageMemoryPlugin extends Plugin implements SettingsHost {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AgentageMemorySettingTab(this.app, this));
    this.addStatusBarItem().setText('Memory: config only');
  }

  /** Absolute path of this vault's folder (desktop); falls back to the vault name. */
  vaultRootPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
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
