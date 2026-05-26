import { Notice, Plugin, PluginSettingTab, Setting, requestUrl, type App } from 'obsidian';
import { DEFAULT_SETTINGS, normalizeServerUrl, type AgentageMemorySettings } from './settings';
import { pingServer } from './connection';
import { destroyLocalDb, pushNoteViaPouch, type PouchFetch, type PushCreds } from './pouch';

// Lucide icon id for the left-ribbon button. Ribbon icons are monochrome
// (theme-tinted); swap for a custom single-color SVG via addIcon() later.
const RIBBON_ICON = 'refresh-cw';

/**
 * Wrap Obsidian's `requestUrl` to look like the browser `fetch` API.
 * PouchDB calls fetch(url, init) and expects a real Response back; Obsidian's
 * requestUrl bypasses CORS for us by running in the Electron main process.
 */
function obsidianFetchForPouch(): PouchFetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const res = await requestUrl({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? undefined,
      body: (init?.body as string) ?? undefined,
      throw: false,
    });
    return new Response(res.text, {
      status: res.status,
      headers: res.headers,
    });
  };
}

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
      () => new Notice('Agentage Memory: use the command palette to push the current note.')
    );

    this.addCommand({
      id: 'push-current-note',
      name: 'Push current note to Agentage Memory',
      callback: async () => {
        await this.pushCurrentNote();
      },
    });

    this.addSettingTab(new AgentageMemorySettingTab(this.app, this));
    console.log('[Agentage Memory] loaded');
  }

  async onunload(): Promise<void> {
    // Free the local IndexedDB handle so a quick disable/enable cycle doesn't leak it.
    await destroyLocalDb().catch((err) => console.warn('[Agentage Memory] destroyLocalDb', err));
    console.log('[Agentage Memory] unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private creds(): PushCreds {
    return {
      serverUrl: this.settings.serverUrl,
      username: this.settings.username,
      password: this.settings.password,
    };
  }

  async pushCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('No active note.');
      return;
    }
    if (file.extension !== 'md') {
      new Notice('Active file is not a Markdown note.');
      return;
    }
    const content = await this.app.vault.read(file);
    try {
      const { id, rev } = await pushNoteViaPouch(
        this.creds(),
        file.path,
        content,
        file.stat.mtime,
        obsidianFetchForPouch()
      );
      const shortRev = rev.split('-')[0];
      new Notice(`Pushed: ${id} (rev ${shortRev})`);
    } catch (err) {
      new Notice(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
