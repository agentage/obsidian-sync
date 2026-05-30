import { Notice, PluginSettingTab, Setting, requestUrl, type App, type Plugin } from 'obsidian';
import { pingServer } from './connection';
import type { SyncController } from './sync-controller';
import type { AuthFlow } from './auth-flow';

export class AgentageMemorySettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly core: SyncController,
    private readonly auth: AuthFlow
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderAccount(containerEl);
    this.renderLocalDev(containerEl);
  }

  private renderAccount(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Account').setHeading();

    new Setting(containerEl)
      .setName('Agentage Sync')
      .setDesc(
        this.auth.isSignedIn()
          ? 'Connected — this vault syncs to your Agentage Memory.'
          : 'Start syncing this vault to your Agentage Memory.'
      )
      .addButton((btn) => {
        if (this.auth.isSignedIn()) {
          btn.setButtonText('Sign out').onClick(() => this.auth.signOut());
        } else {
          btn
            .setButtonText('Start sync')
            .setCta()
            .onClick(() => this.auth.startSignIn());
        }
      });

    new Setting(containerEl)
      .setName('Auth endpoint')
      .setDesc('GoTrue base URL. Leave the default unless told otherwise.')
      .addText((text) =>
        text
          .setPlaceholder('https://dev.agentage.io/auth/v1')
          .setValue(this.core.getSettings().authBase)
          .onChange((value) => this.core.setAuthBase(value))
      );

    new Setting(containerEl)
      .setName('Auth key')
      .setDesc('Public Agentage auth key (provided with your account). Required to sign in.')
      .addText((text) =>
        text
          .setValue(this.core.getSettings().anonKey)
          .onChange((value) => this.core.setAnonKey(value))
      );
  }

  private renderLocalDev(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Local dev').setHeading();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your Agentage Memory cloud endpoint. Leave the default unless told otherwise.')
      .addText((text) =>
        text
          .setPlaceholder('https://memory.agentage.io')
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
