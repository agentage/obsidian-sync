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
  #settingTab?: AgentageMemorySettingTab;

  async onload(): Promise<void> {
    const statusBar = this.addStatusBarItem();
    const secrets: SecretStore = {
      get: (id) => this.app.secretStorage.getSecret(id),
      set: (id, value) => this.app.secretStorage.setSecret(id, value),
    };
    // The controller needs `isSignedIn` to gate replication, but `auth` is
    // created after `core` (it reads `core.getSettings()`). Bridge the cycle
    // with a thunk that resolves to the real auth check once `auth` exists.
    let isSignedIn = (): boolean => false;
    const core = createSyncController({
      app: this.app,
      secrets,
      load: () => this.loadData(),
      save: (data) => this.saveData(data),
      registerEvent: (ref) => this.registerEvent(ref),
      statusBar,
      isSignedIn: () => isSignedIn(),
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
      // On sign-in/out: re-render the settings tab (the callback arrives async
      // via the protocol handler, so the button flips without a reload) and
      // re-evaluate the replication gate now that `isSignedIn` may have changed.
      onChange: () => {
        this.#settingTab?.display();
        core.refreshReplication();
      },
    });
    // Now that `auth` exists, point the controller's gate at the real check.
    isSignedIn = auth.isSignedIn;
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
      name: 'Push current note',
      callback: () => core.pushCurrentNote(),
    });
    this.addCommand({
      id: 'sign-in',
      name: 'Sign in',
      callback: () => auth.startSignIn(),
    });
    this.addCommand({
      id: 'sign-out',
      name: 'Sign out',
      callback: () => auth.signOut(),
    });
    this.#settingTab = new AgentageMemorySettingTab(this.app, this, core, auth);
    this.addSettingTab(this.#settingTab);

    await core.start();
  }

  async onunload(): Promise<void> {
    await this.#core?.stop();
  }
}
