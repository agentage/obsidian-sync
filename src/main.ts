import { Notice, Plugin, PluginSettingTab, Setting, type App } from 'obsidian';
import { DEFAULT_SETTINGS, normalizeServerUrl, type AgentageMemorySettings } from './settings';

// Lucide icon id for the left-ribbon button. Ribbon icons are monochrome
// (theme-tinted); swap for a custom single-color SVG via addIcon() later.
const RIBBON_ICON = 'refresh-cw';

// NOTE: Obsidian loads the entry plugin class as the module's DEFAULT export.
// This is the one place we use a default export (platform requirement);
// everything else in src/ uses named exports per the project conventions.
export default class AgentageMemoryPlugin extends Plugin {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addRibbonIcon(
      RIBBON_ICON,
      'Agentage Memory',
      () => new Notice('Agentage Memory: not connected yet')
    );

    this.addSettingTab(new AgentageMemorySettingTab(this.app, this));
    console.log('[Agentage Memory] loaded');
  }

  onunload(): void {
    console.log('[Agentage Memory] unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class AgentageMemorySettingTab extends PluginSettingTab {
  private readonly plugin: AgentageMemoryPlugin;

  constructor(app: App, plugin: AgentageMemoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your Agentage Memory cloud endpoint. Leave the default unless told otherwise.')
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
