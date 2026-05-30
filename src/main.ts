import { Notice, Plugin, requestUrl } from 'obsidian';
import { createSyncController, type SyncController } from './sync-controller';
import { CALLBACK_ACTION, REDIRECT_URI, createAuthFlow } from './auth-flow';
import { requestSyncBootstrap, type SyncBootstrap } from './bootstrap';
import type { HttpPost } from './oauth';
import type { SecretStore } from './credentials';
import { AgentageMemorySettingTab } from './settings-tab';

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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
    // The controller needs `isSignedIn` + `syncBootstrap`, but `auth` is created
    // after `core` (it reads `core.getSettings()`). Bridge the cycle with thunks
    // that resolve to the real auth-backed impls once `auth` exists.
    let isSignedIn = (): boolean => false;
    let syncBootstrap = async (): Promise<SyncBootstrap | null> => null;
    const core = createSyncController({
      app: this.app,
      secrets,
      load: () => this.loadData(),
      save: (data) => this.saveData(data),
      registerEvent: (ref) => this.registerEvent(ref),
      statusBar,
      isSignedIn: () => isSignedIn(),
      syncBootstrap: () => syncBootstrap(),
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
    // Now that `auth` exists, point the controller's gate at the real check
    // and wire the bootstrap: trade a valid account token for a per-tenant sync
    // target. Single-host model — the API origin is the SYNC host (serverUrl),
    // which also fronts /auth and /api/sync (e.g. sync.agentage.io); the plugin
    // contacts exactly one host. Anchored on serverUrl (not authBase) so the
    // bootstrap follows wherever sync points.
    isSignedIn = auth.isSignedIn;
    const bootstrapPost: HttpPost = async (url, init) => {
      const res = await requestUrl({
        url,
        method: 'POST',
        headers: init.headers,
        body: init.body,
        throw: false,
      });
      return { status: res.status, json: safeJson(res.text) };
    };
    syncBootstrap = async () => {
      const token = await auth.getValidAccessToken();
      if (!token) return null;
      const apiBase = new URL(core.getSettings().serverUrl).origin;
      return requestSyncBootstrap(bootstrapPost, apiBase, token, Date.now());
    };
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
