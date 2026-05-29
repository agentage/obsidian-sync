import { Notice, PluginSettingTab, Setting, requestUrl, type App, type Plugin } from 'obsidian';
import { pingServer } from './connection';
import type { SyncController } from './sync-controller';

export class AgentageMemorySettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly core: SyncController
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
          .setValue(this.core.getSettings().serverUrl)
          .onChange((value) => this.core.setServerUrl(value))
      );

    new Setting(containerEl)
      .setName('Username')
      .setDesc('CouchDB username — local dev only. Stored in encrypted secret storage.')
      .addText((text) =>
        text
          .setPlaceholder('admin')
          .setValue(this.core.getBasicCreds().username)
          .onChange((value) => this.core.setUsername(value))
      );

    new Setting(containerEl)
      .setName('Database name')
      .setDesc('CouchDB database. Override only for tests or per-vault setups.')
      .addText((text) =>
        text
          .setPlaceholder('agentage-memory')
          .setValue(this.core.getSettings().dbName)
          .onChange((value) => this.core.setDbName(value))
      );

    new Setting(containerEl)
      .setName('Password')
      .setDesc('CouchDB password — local dev only. Stored in encrypted secret storage.')
      .addText((text) => {
        text
          .setPlaceholder('agentage')
          .setValue(this.core.getBasicCreds().password)
          .onChange((value) => this.core.setPassword(value));
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Ping the server URL to confirm it is reachable.')
      .addButton((btn) =>
        btn.setButtonText('Test').onClick(async () => {
          btn.setDisabled(true).setButtonText('Testing…');
          const r = await pingServer(this.core.getSettings().serverUrl, async (u) => {
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
