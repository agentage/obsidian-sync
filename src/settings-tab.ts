import { Notice, PluginSettingTab, Setting, requestUrl, type App } from 'obsidian';
import type AgentageMemoryPlugin from './main';
import { normalizeServerUrl } from './settings';
import { pingServer } from './connection';

export class AgentageMemorySettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AgentageMemoryPlugin
  ) {
    super(app, plugin);
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
            this.plugin.startReplication();
          })
      );

    new Setting(containerEl)
      .setName('Username')
      .setDesc('CouchDB username (local dev only — moves to OAuth + secret storage later).')
      .addText((text) =>
        text
          .setPlaceholder('admin')
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value.trim();
            await this.plugin.saveSettings();
            this.plugin.startReplication();
          })
      );

    new Setting(containerEl)
      .setName('Password')
      .setDesc('CouchDB password (stored in plaintext data.json — local dev only).')
      .addText((text) => {
        text
          .setPlaceholder('agentage')
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
            this.plugin.startReplication();
          });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Ping the server URL to confirm it is reachable.')
      .addButton((btn) =>
        btn.setButtonText('Test').onClick(async () => {
          btn.setDisabled(true).setButtonText('Testing…');
          const r = await pingServer(this.plugin.settings.serverUrl, async (u) => {
            const res = await requestUrl({ url: u, method: 'GET', throw: false });
            return { status: res.status };
          });
          btn.setDisabled(false).setButtonText('Test');
          new Notice(
            r.ok
              ? `Connected (HTTP ${r.status})`
              : `Failed: ${r.error ?? `HTTP ${r.status ?? '?'}`}`
          );
        })
      );
  }
}
