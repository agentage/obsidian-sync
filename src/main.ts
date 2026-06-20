import { FileSystemAdapter, Menu, Notice, Platform, Plugin, requestUrl } from 'obsidian';
import type { FsClient, MergeDriverCallback } from 'isomorphic-git';
import { type AgentageMemorySettings, DEFAULT_SETTINGS, normalizeVaultName } from './settings';
import { AgentageMemorySettingTab, type SettingsHost } from './settings-tab';
import { applyVaultsConfig, type ApplyResult } from './vaults-config';
import { createGitClient } from './git/git-client';
import { requestUrlHttpClient } from './git/http-requesturl';
import { VaultFs } from './git/vault-fs';
import { mergeNote } from './git/merge-note';
import { createSyncController, type SyncController, type SyncStatus } from './sync-controller';
import { CALLBACK_ACTION, createAuthFlow, type AuthFlow } from './auth/auth-flow';
import {
  createAuthStore,
  type SecretStore,
  ACCESS_TOKEN_SECRET,
  REFRESH_TOKEN_SECRET,
  EXPIRES_AT_SECRET,
  CLIENT_ID_SECRET,
} from './auth/token-store';
import { createAuthJsonWriter, readAuthJsonState } from './auth/auth-json';
import type { HttpPost } from './auth/oauth';
import type { GetJson } from './auth/discovery';
import { HostResolver, buildRepoUrl } from './resolve-host';

const AUTH_ORIGIN = 'https://auth.agentage.io';
const SYNC_ORIGIN = 'https://sync.agentage.io';
const DASHBOARD_ORIGIN = 'https://dashboard.agentage.io';
const SITE_FQDN = 'agentage.io';

// 3-way merge driver: split-YAML field-LWW + diff3 body (see git/merge-note).
const agentageMergeDriver: MergeDriverCallback = ({ contents }) => {
  const [base, ours, theirs] = contents;
  const { text, clean } = mergeNote(base, ours, theirs);
  return { cleanMerge: clean, mergedText: text };
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Agentage Sync plugin. Config page (writes ~/.agentage/vaults.json) + OAuth sign-in
// (token in secretStorage/localStorage + ~/.agentage/auth.json) + desktop git sync.
export default class AgentageMemoryPlugin extends Plugin implements SettingsHost {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;
  isDesktop = Platform.isDesktopApp;
  private statusBar?: HTMLElement;
  private statusDot?: HTMLElement;
  private settingTab?: AgentageMemorySettingTab;
  private auth!: AuthFlow;
  private resolver!: HostResolver;
  private syncState: SyncStatus = 'idle';
  private syncMsg?: string;
  // In-memory mirror of the secret store: guarantees the sign-in round-trip works even
  // if the OS keyring (secretStorage) is unavailable; persisted via secretStorage +
  // ~/.agentage/auth.json. Hydrated from auth.json on desktop at load.
  private readonly secretCache = new Map<string, string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.buildAuth();
    await this.hydrateAuth();

    this.settingTab = new AgentageMemorySettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerObsidianProtocolHandler(CALLBACK_ACTION, (params) => {
      console.debug('[Agentage Sync] OAuth callback received', { hasCode: !!params.code });
      void this.auth.handleCallback(params).then(() => this.onAuthChanged());
    });

    this.addRibbonIcon('refresh-cw', 'Agentage Sync', () => this.openSettings());
    const sb = this.addStatusBarItem();
    this.statusBar = sb;
    sb.addClass('ams-statusbar', 'mod-clickable');
    // A REAL child element — an empty status-bar item (only a ::before) is hidden by Obsidian.
    this.statusDot = sb.createSpan({ cls: 'ams-sb-dot' });
    this.registerDomEvent(sb, 'click', (evt) => this.showStatusMenu(evt));
    this.refreshStatus();

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.syncNow().then((r) => new Notice(`Agentage Sync: ${r.message}`)),
    });
  }

  private buildAuth(): void {
    // Token store: an in-memory cache (always works in-session) mirrored to Obsidian's
    // encrypted secretStorage, never data.json/vaults.json. secretStorage can THROW when
    // the OS keyring is unavailable (common on headless/keyring-less Linux) — we log and
    // keep the token in the cache + ~/.agentage/auth.json so sign-in still works.
    const ss = (
      this.app as unknown as {
        secretStorage?: {
          getSecret(id: string): string | null;
          setSecret(id: string, value: string): void;
        };
      }
    ).secretStorage;
    if (!ss)
      console.warn('[Agentage Sync] app.secretStorage unavailable; using in-memory + auth.json');
    const secrets: SecretStore = {
      get: (id) => {
        const cached = this.secretCache.get(id);
        if (cached !== undefined) return cached === '' ? null : cached;
        try {
          const v = ss?.getSecret(id);
          if (typeof v === 'string') {
            this.secretCache.set(id, v);
            return v === '' ? null : v;
          }
        } catch (e) {
          console.error('[Agentage Sync] secretStorage.getSecret failed:', e);
        }
        return null;
      },
      set: (id, value) => {
        this.secretCache.set(id, value);
        try {
          ss?.setSecret(id, value);
        } catch (e) {
          console.error(
            '[Agentage Sync] secretStorage.setSecret failed (kept in memory + auth.json):',
            e
          );
        }
      },
    };
    const authJson = this.isDesktop
      ? createAuthJsonWriter({ configDirSetting: this.settings.configDir, siteFqdn: SITE_FQDN })
      : null;
    const store = createAuthStore(secrets, authJson);
    const post: HttpPost = async (url, init) => {
      const res = await requestUrl({
        url,
        method: 'POST',
        headers: init.headers,
        body: init.body,
        throw: false,
      });
      return { status: res.status, json: safeJson(res.text) };
    };
    const getJson: GetJson = async (url) => {
      const res = await requestUrl({ url, method: 'GET', throw: false });
      return { status: res.status, json: safeJson(res.text) };
    };
    this.auth = createAuthFlow({
      store,
      post,
      getJson,
      authOrigin: () => AUTH_ORIGIN,
      notify: (m) => new Notice(m),
      openExternal: (url) => {
        console.debug('[Agentage Sync] opening authorize URL in browser');
        window.open(url, '_blank');
      },
      now: () => Date.now(),
      onChange: () => this.onAuthChanged(),
    });
    this.resolver = new HostResolver(
      SYNC_ORIGIN,
      async (url, token) => {
        const res = await requestUrl({
          url,
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          throw: false,
        });
        return { status: res.status, json: safeJson(res.text) };
      },
      () => Date.now()
    );
  }

  private setStatusBar(s: SyncStatus, msg?: string): void {
    this.syncState = s;
    this.syncMsg = msg;
    this.refreshStatus();
  }

  /** Seed the token cache from ~/.agentage/auth.json (desktop) so sign-in survives a
   * reload even without a keyring, and is shared with the CLI. No-op on mobile. */
  private async hydrateAuth(): Promise<void> {
    if (!this.isDesktop) return;
    const state = await readAuthJsonState(this.settings.configDir);
    if (!state?.tokens?.accessToken || !state.tokens.refreshToken) return;
    if (state.clientId) this.secretCache.set(CLIENT_ID_SECRET, state.clientId);
    this.secretCache.set(ACCESS_TOKEN_SECRET, state.tokens.accessToken);
    this.secretCache.set(REFRESH_TOKEN_SECRET, state.tokens.refreshToken);
    if (state.tokens.expiresAt != null)
      this.secretCache.set(EXPIRES_AT_SECRET, String(state.tokens.expiresAt));
    console.debug('[Agentage Sync] auth hydrated from auth.json');
  }

  private onAuthChanged(): void {
    this.settingTab?.display();
    this.refreshStatus();
  }

  /** Status bar: colored dot only (green ready / red error / gray signed-out) + tooltip. */
  private refreshStatus(): void {
    if (!this.statusBar || !this.statusDot) return;
    const signedIn = !!this.auth && this.auth.isSignedIn();
    const erroring = this.syncState === 'error' || this.syncState === 'conflict';
    const tone = !signedIn ? 'gray' : erroring ? 'red' : 'green';
    this.statusDot.removeClass('is-green', 'is-red', 'is-gray');
    this.statusDot.addClass(`is-${tone}`);
    const tip = !signedIn
      ? 'Agentage Sync — not signed in. Click to sign in.'
      : erroring
        ? `Agentage Sync — ${this.syncState}${this.syncMsg ? `: ${this.syncMsg}` : ''}. Click for options.`
        : this.syncState === 'syncing'
          ? 'Agentage Sync — syncing… Click for options.'
          : 'Agentage Sync — signed in and ready. Click for options.';
    this.statusBar.setAttribute('aria-label', tip);
    this.statusBar.setAttribute('title', tip);
  }

  /** Click the status bar → context menu (sign in, or sync / dashboard / settings). */
  private showStatusMenu(evt: MouseEvent): void {
    const menu = new Menu();
    if (this.isSignedIn()) {
      menu.addItem((i) =>
        i
          .setTitle('Sync now')
          .setIcon('refresh-cw')
          .onClick(() => void this.syncNow().then((r) => new Notice(`Agentage Sync: ${r.message}`)))
      );
      menu.addItem((i) =>
        i
          .setTitle('Open dashboard')
          .setIcon('layout-dashboard')
          .onClick(() => this.openDashboard())
      );
      menu.addItem((i) =>
        i
          .setTitle('Open settings')
          .setIcon('settings')
          .onClick(() => this.openSettings())
      );
    } else {
      menu.addItem((i) =>
        i
          .setTitle('Sign in to Agentage')
          .setIcon('log-in')
          .onClick(() => this.openSignIn())
      );
      menu.addItem((i) =>
        i
          .setTitle('Open settings')
          .setIcon('settings')
          .onClick(() => this.openSettings())
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private openSettings(): void {
    const app = this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    };
    app.setting?.open?.();
    app.setting?.openTabById?.(this.manifest.id);
  }

  /** Open this vault's memories in the Agentage dashboard (browser). */
  private openDashboard(): void {
    window.open(`${DASHBOARD_ORIGIN}/memories/${encodeURIComponent(this.vaultNameOf())}`, '_blank');
  }

  vaultRootPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
  }

  private vaultNameOf(): string {
    return (
      normalizeVaultName(this.settings.vaultName) ||
      normalizeVaultName(this.app.vault.getName()) ||
      'personal'
    );
  }

  // --- auth (SettingsHost) ---
  openSignIn(): void {
    void this.auth.startSignIn();
  }
  isSignedIn(): boolean {
    return this.auth.isSignedIn();
  }
  disconnect(): Promise<void> {
    return this.auth.disconnect();
  }

  // Desktop: node fs against the absolute vault path (the unit/integration-tested path).
  // Mobile: the VaultFs shim over vault.adapter — vault-relative dir ('' = vault root,
  // .git inside the vault), same engine + adopt-guard. Mobile is best-effort and not
  // yet device-verified; the desktop branch is unchanged.
  private async buildController(): Promise<SyncController> {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      const nodefs = (await import('node:fs')) as unknown as FsClient;
      return this.makeController(nodefs, adapter.getBasePath());
    }
    const vfs = new VaultFs(this.app.vault, '.git') as unknown as FsClient;
    return this.makeController(vfs, '', '.git');
  }

  private makeController(fs: FsClient, dir: string, gitdir?: string): SyncController {
    const client = createGitClient({ fs, http: requestUrlHttpClient }, agentageMergeDriver);
    return createSyncController({
      client,
      fs,
      dir,
      gitdir,
      ignore: [this.app.vault.configDir],
      now: () => new Date().toISOString(),
      onStatus: (s, msg) => this.setStatusBar(s, msg),
    });
  }

  async syncNow(): Promise<{ ok: boolean; message: string }> {
    const token = await this.auth.getValidToken();
    if (!token) return { ok: false, message: 'Sign in to Agentage first (Connect).' };
    let remote = this.settings.origin.remote.trim();
    // Managed remote: resolve the per-user git endpoint from the live sync host.
    if (!remote || remote === 'agentage') {
      try {
        const res = await this.resolver.resolve(token);
        const want = this.vaultNameOf();
        const vault = res.vaults.includes(want) ? want : (res.vaults[0] ?? want);
        remote = buildRepoUrl(res.gitEndpoint, vault);
      } catch (e) {
        return {
          ok: false,
          message: `Couldn't reach the agentage sync host: ${(e as Error).message}`,
        };
      }
    }
    const ctrl = await this.buildController();
    try {
      const r = await ctrl.syncNow({ url: remote, token });
      if (r.action === 'blocked') return { ok: false, message: r.message ?? 'blocked' };
      if (r.conflicted.length)
        return {
          ok: false,
          message: `Conflicts in ${r.conflicted.length} file(s) — see "Agentage Sync Conflicts".`,
        };
      const bits = [r.action, r.committed ? 'committed' : '', r.pushed ? 'pushed' : ''].filter(
        Boolean
      );
      return { ok: true, message: bits.join(' + ') };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** Upsert this vault into ~/.agentage/vaults.json, preserving hand-edits + CLI vaults. */
  async applyConfig(): Promise<ApplyResult> {
    const s = this.settings;
    const name = this.vaultNameOf();
    const res = await applyVaultsConfig({
      configDirSetting: s.configDir,
      name,
      previousName: s.writtenVaultName || undefined,
      makeDefault: s.makeDefault,
      path: s.path.trim() || this.vaultRootPath(),
      syncEnabled: s.syncEnabled,
      remote: s.origin.remote,
      mcp: s.mcp,
    });
    if (res.ok) {
      s.writtenVaultName = name;
      await this.saveSettings();
    }
    return res;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<AgentageMemorySettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
    this.settings.origin = { ...DEFAULT_SETTINGS.origin, ...this.settings.origin };
    if (!Array.isArray(this.settings.mcp)) this.settings.mcp = [...DEFAULT_SETTINGS.mcp];
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
