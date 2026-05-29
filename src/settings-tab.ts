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
      .setDesc('CouchDB username — local dev only. Stored in encrypted secret storage.')
      .addText((text) =>
        text
          .setPlaceholder('admin')
          .setValue(this.plugin.getBasicCreds().username)
          .onChange((value) => {
            this.plugin.setUsername(value);
          })
      );

    new Setting(containerEl)
      .setName('Database name')
      .setDesc('CouchDB database. Override only for tests or per-vault setups.')
      .addText((text) =>
        text
          .setPlaceholder('agentage-memory')
          .setValue(this.plugin.settings.dbName)
          .onChange(async (value) => {
            this.plugin.settings.dbName = value.trim() || 'agentage-memory';
            await this.plugin.saveSettings();
            this.plugin.startReplication();
          })
      );

    new Setting(containerEl)
      .setName('Password')
      .setDesc('CouchDB password — local dev only. Stored in encrypted secret storage.')
      .addText((text) => {
        text
          .setPlaceholder('agentage')
          .setValue(this.plugin.getBasicCreds().password)
          .onChange((value) => {
            this.plugin.setPassword(value);
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
