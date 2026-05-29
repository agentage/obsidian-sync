import { Notice, Plugin } from 'obsidian';
import { createSyncController, type SyncController } from './sync-controller';
import { CALLBACK_ACTION, REDIRECT_URI, createAuthFlow } from './auth-flow';
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
    const secrets: SecretStore = {
      get: (id) => this.app.secretStorage.getSecret(id),
      set: (id, value) => this.app.secretStorage.setSecret(id, value),
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

    const auth = createAuthFlow({
      secrets,
      config: () => {
        const s = core.getSettings();
        return { authBase: s.authBase, anonKey: s.anonKey, redirectUri: REDIRECT_URI };
      },
      notify: (message) => new Notice(message),
      openExternal: (url) => window.open(url, '_blank'),
      now: () => Date.now(),
    });
    // GoTrue redirects to obsidian://agentage-memory-cb?code=… after sign-in.
    this.registerObsidianProtocolHandler(CALLBACK_ACTION, (params) => {
      void auth.handleCallback(params);
    });

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
    this.addCommand({
      id: 'sign-in',
      name: 'Sign in to Agentage',
      callback: () => auth.startSignIn(),
    });
    this.addCommand({
      id: 'sign-out',
      name: 'Sign out of Agentage',
      callback: () => auth.signOut(),
    });
    this.addSettingTab(new AgentageMemorySettingTab(this.app, this, core, auth));

    await core.start();
  }

  async onunload(): Promise<void> {
    await this.#core?.stop();
  }
}
