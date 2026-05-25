import { Notice, Plugin, PluginSettingTab, Setting, type App } from 'obsidian';
import { DEFAULT_SETTINGS, normalizeServerUrl, type AgentageVaultSettings } from './settings';

// Lucide icon id for the left-ribbon button. Ribbon icons are monochrome
// (theme-tinted); swap for a custom single-color SVG via addIcon() later.
const RIBBON_ICON = 'refresh-cw';

// NOTE: Obsidian loads the entry plugin class as the module's DEFAULT export.
// This is the one place we use a default export (platform requirement);
// everything else in src/ uses named exports per the project conventions.
export default class AgentageVaultPlugin extends Plugin {
  settings: AgentageVaultSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addRibbonIcon(
      RIBBON_ICON,
      'Agentage Vault Sync',
      () => new Notice('Agentage Vault Sync: not connected yet')
    );

    this.addSettingTab(new AgentageVaultSettingTab(this.app, this));
    console.log('[Agentage Vault Sync] loaded');
  }

  onunload(): void {
    console.log('[Agentage Vault Sync] unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class AgentageVaultSettingTab extends PluginSettingTab {
  private readonly plugin: AgentageVaultPlugin;

  constructor(app: App, plugin: AgentageVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your agentage cloud endpoint. Leave the default unless told otherwise.')
      .addText((text) =>
        text
          .setPlaceholder('https://mcp.agentage.io')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = normalizeServerUrl(value);
            await this.plugin.saveSettings();
          })
      );
  }
}
