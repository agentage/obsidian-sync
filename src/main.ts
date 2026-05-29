import { Notice, Plugin } from 'obsidian';
import { createSyncController, type SyncController } from './sync-controller';
import type { SecretStore } from './credentials';
import { AgentageMemorySettingTab } from './settings-tab';

const RIBBON_ICON = 'refresh-cw';

// Obsidian loads the entry plugin class as the module's DEFAULT export — the
// one default export in the project. The class is a thin adapter: it wires
// Obsidian's lifecycle to the functional sync core in `sync-controller.ts`,
// which owns all state.
export default class AgentageMemoryPlugin extends Plugin {
  #core?: SyncController;

  async onload(): Promise<void> {
    const statusBar = this.addStatusBarItem();
    // Defensive adapter: `app.secretStorage` is absent (e.g., headless CI with no
    // OS keyring backend) or `getSecret` is async on some Obsidian builds. On
    // either, fall through to legacy data.json creds via `resolveBasicCreds`
    // rather than letting onload abort — without this, the status icon never
    // renders and replication never starts.
    const secrets: SecretStore = {
      get: (id) => {
        try {
          const v: unknown = this.app.secretStorage?.getSecret(id);
          if (v instanceof Promise) return null;
          return typeof v === 'string' ? v : null;
        } catch {
          return null;
        }
      },
      set: (id, value) => {
        try {
          const r: unknown = this.app.secretStorage?.setSecret(id, value);
          if (r instanceof Promise) void r.catch(() => undefined);
        } catch {
          /* secretStorage unavailable; the creds stay in-memory for this session */
        }
      },
    };
    const core = createSyncController({
      app: this.app,
      secrets,
      load: () => this.loadData(),
      save: (data) => this.saveData(data),
      registerEvent: (ref) => this.registerEvent(ref),
      statusBar,
    });
    this.#core = core;

    this.addRibbonIcon(
      RIBBON_ICON,
      'Agentage Memory',
      () =>
        new Notice('Agentage Memory: edits auto-sync; use the command palette to push manually.')
    );
    this.addCommand({
      id: 'push-current-note',
      name: 'Push current note to Agentage Memory',
      callback: () => core.pushCurrentNote(),
    });
    this.addSettingTab(new AgentageMemorySettingTab(this.app, this, core));

    await core.start();
  }

  async onunload(): Promise<void> {
    await this.#core?.stop();
  }
}
