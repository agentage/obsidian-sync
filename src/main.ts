import { FileSystemAdapter, Menu, Notice, Platform, Plugin, requestUrl } from 'obsidian';
import type { FsClient, MergeDriverCallback } from 'isomorphic-git';
import {
  type AgentageMemorySettings,
  type VaultInfo,
  type VaultListResult,
  DEFAULT_SETTINGS,
  normalizeVaultName,
} from './settings';
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
import { openMemoryChooser } from './memory-chooser';
import { openActionsMenu, type PluginAction } from './actions-menu';
import { openSyncPreview, type SyncPreview } from './sync-preview-modal';

// Single-host: every origin derives from SITE_FQDN. Defaults to prod; the
// AGENTAGE_SITE_FQDN env var (desktop only, same pattern as AGENTAGE_CONFIG_DIR)
// repoints it at dev for e2e (e.g. dev.agentage.io -> sync.dev.agentage.io).
const SITE_FQDN =
  (typeof process !== 'undefined' ? process.env?.AGENTAGE_SITE_FQDN : undefined) ?? 'agentage.io';
const AUTH_ORIGIN = `https://auth.${SITE_FQDN}`;
const SYNC_ORIGIN = `https://sync.${SITE_FQDN}`;
// Memory management (list + create) lives on the backend API host, not the sync git
// host; sync.<fqdn> stays a pure git transport (resolution + push/pull).
const API_ORIGIN = `https://api.${SITE_FQDN}`;
const DASHBOARD_ORIGIN = `https://dashboard.${SITE_FQDN}`;

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

// Map a backend `Memory` (GET/POST /api/memories) to the plugin's VaultInfo: entries ->
// files, folderCount -> folders, empty = no entries. Anything without a name is dropped.
const memoryToVaultInfo = (m: unknown): VaultInfo | null => {
  if (!m || typeof m !== 'object' || typeof (m as { name?: unknown }).name !== 'string')
    return null;
  const o = m as Record<string, unknown>;
  const files = Number(o.entries) || 0;
  return {
    name: o.name as string,
    files,
    folders: Number(o.folderCount) || 0,
    updated: typeof o.updated === 'string' ? o.updated : null,
    empty: files === 0,
  };
};

// Agentage Sync plugin. Config page (writes ~/.agentage/vaults.json) + OAuth sign-in
// (token in secretStorage/localStorage + ~/.agentage/auth.json) + desktop git sync.
export default class AgentageMemoryPlugin extends Plugin implements SettingsHost {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;
  isDesktop = Platform.isDesktopApp;
  private statusBar?: HTMLElement;
  private statusDot?: HTMLElement;
  private statusEl?: HTMLElement; // optional label (e.g. "Choose memory"); empty otherwise
  private settingTab?: AgentageMemorySettingTab;
  private auth!: AuthFlow;
  private resolver!: HostResolver;
  private syncState: SyncStatus = 'idle';
  private syncMsg?: string;
  private lastVault?: string; // the server vault name we last synced (for the dashboard link)
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
      void this.auth.handleCallback(params).then(() => {
        this.onAuthChanged();
        this.autoSyncOnReady(true); // sign-in complete -> auto-sync + show the popup
      });
    });

    // Ribbon + command open a modal action-picker (Sync now / Choose memory / dashboard).
    // Kept alongside the status-bar dot so the same actions survive when there's no status
    // bar (the mobile case, once mobile is re-enabled — desktop-only for now).
    this.addRibbonIcon('network', 'Agentage Sync', () => this.openActions());
    const sb = this.addStatusBarItem();
    this.statusBar = sb;
    sb.addClass('ams-statusbar', 'mod-clickable');
    // A REAL child element — an empty status-bar item (only a ::before) is hidden by Obsidian.
    this.statusDot = sb.createSpan({ cls: 'ams-sb-dot' });
    this.statusEl = sb.createSpan({ cls: 'ams-sb-text' });
    this.registerDomEvent(sb, 'click', (evt) => this.showStatusMenu(evt));
    this.refreshStatus();

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.syncNow().then((r) => new Notice(`Agentage Sync: ${r.message}`)),
    });
    this.addCommand({
      id: 'choose-memory',
      name: 'Choose memory',
      callback: () => this.chooseMemory(),
    });
    this.addCommand({ id: 'open-menu', name: 'Open menu', callback: () => this.openActions() });
    // Already signed in with a memory at startup -> sync silently (no popup every launch).
    this.autoSyncOnReady(false);
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
    // Never replay a token minted for a different host (e.g. a dev auth.json against prod).
    if (state.siteFqdn && state.siteFqdn !== SITE_FQDN) {
      console.debug('[Agentage Sync] auth.json is for a different host; skipping hydration');
      return;
    }
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

  /** Status bar dot: gray (signed out) / amber (signed in, no memory chosen) /
   * green (ready or syncing) / red (error). Green only means "ready to sync". */
  private refreshStatus(): void {
    if (!this.statusBar || !this.statusDot) return;
    const signedIn = !!this.auth && this.auth.isSignedIn();
    const erroring = this.syncState === 'error' || this.syncState === 'conflict';
    const hasMemory = !!this.settings.vault.trim();
    let tone: 'gray' | 'amber' | 'green' | 'red';
    let tip: string;
    if (!signedIn) {
      tone = 'gray';
      tip = 'Agentage Sync — not signed in. Click to sign in.';
    } else if (erroring) {
      tone = 'red';
      tip = `Agentage Sync — ${this.syncState}${this.syncMsg ? `: ${this.syncMsg}` : ''}. Click for options.`;
    } else if (this.syncState === 'syncing') {
      tone = 'green';
      tip = 'Agentage Sync — syncing… Click for options.';
    } else if (!hasMemory) {
      tone = 'amber';
      tip = 'Agentage Sync — signed in. Choose a memory to sync into. Click to choose.';
    } else {
      tone = 'green';
      tip = `Agentage Sync — ready (${this.settings.vault}). Click for options.`;
    }
    this.statusDot.removeClass('is-gray', 'is-amber', 'is-green', 'is-red');
    this.statusDot.addClass(`is-${tone}`);
    // A visible label for the two states that need a user action (not just a tooltip).
    const label = tone === 'gray' ? 'Sign in' : tone === 'amber' ? 'Choose Memory' : '';
    this.statusEl?.setText(label);
    this.statusBar.setAttribute('aria-label', tip);
    this.statusBar.setAttribute('title', tip);
  }

  private needsMemory(): boolean {
    return this.isSignedIn() && !this.settings.vault.trim();
  }

  /** The single source of truth for the plugin's quick actions, by state. */
  private actions(): PluginAction[] {
    const settings: PluginAction = {
      title: 'Open settings',
      icon: 'settings',
      run: () => this.openSettings(),
    };
    if (!this.isSignedIn())
      return [
        { title: 'Sign in to Agentage', icon: 'log-in', run: () => this.openSignIn() },
        settings,
      ];
    // Signed in but no memory yet: the only useful action is to pick one.
    if (this.needsMemory())
      return [
        { title: 'Choose Memory', icon: 'library', run: () => this.chooseMemory() },
        settings,
      ];
    // Memory selected: no "Choose Memory" here (change it from Settings); no Disconnect either.
    return [
      {
        title: 'Sync now',
        icon: 'refresh-cw',
        run: () => void this.syncNow().then((r) => new Notice(`Agentage Sync: ${r.message}`)),
      },
      { title: 'Open dashboard', icon: 'layout-dashboard', run: () => this.openDashboard() },
      settings,
    ];
  }

  /** Desktop status-bar dot → a context Menu at the cursor. */
  private showStatusMenu(evt: MouseEvent): void {
    const menu = new Menu();
    for (const a of this.actions())
      menu.addItem((i) =>
        i
          .setTitle(a.title)
          .setIcon(a.icon ?? 'circle')
          .onClick(a.run)
      );
    menu.showAtMouseEvent(evt);
  }

  /** Ribbon + command → a modal action-picker. Works on mobile (no status bar there, and
   * Menu.showAtMouseEvent does not render from a tap); the ribbon is the mobile entry. */
  private openActions(): void {
    openActionsMenu(this.app, this.actions());
  }

  private openSettings(): void {
    const app = this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    };
    app.setting?.open?.();
    app.setting?.openTabById?.(this.manifest.id);
  }

  /** Open the dashboard at the current memory, e.g. .../memories/default. Falls back to
   * the last synced one, then the memories list if nothing is chosen yet. */
  private openDashboard(): void {
    const v = this.settings.vault || this.lastVault;
    const base = `${DASHBOARD_ORIGIN}/memories`;
    window.open(v ? `${base}/${encodeURIComponent(v)}` : base, '_blank');
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

  // --- memory selection (SettingsHost) ---
  /** Existing server memories + their info (files/folders/updated) via GET
   * api.<fqdn>/api/memories. Returns a result so the chooser can show a real error
   * (with Retry) vs an empty account. */
  async listVaults(): Promise<VaultListResult> {
    const token = await this.auth.getValidToken();
    if (!token) return { ok: false, error: 'Sign in to Agentage first.' };
    try {
      const r = await requestUrl({
        url: `${API_ORIGIN}/api/memories`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      if (r.status < 200 || r.status >= 300) {
        const body = safeJson(r.text) as { error?: { message?: string } } | null;
        return {
          ok: false,
          error: body?.error?.message ?? `Couldn't load memories (HTTP ${r.status})`,
        };
      }
      const raw = (safeJson(r.text) as { data?: unknown })?.data;
      const vaults = Array.isArray(raw)
        ? raw.map(memoryToVaultInfo).filter((v): v is VaultInfo => v !== null)
        : [];
      return { ok: true, vaults };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Create a new server memory via POST api.<fqdn>/api/memories (the management API;
   * the sync host stays a pure git transport and git push never creates — R14). */
  async createVault(name: string): Promise<{ ok: boolean; vault?: string; error?: string }> {
    const token = await this.auth.getValidToken();
    if (!token) return { ok: false, error: 'Sign in to Agentage first.' };
    const vault = normalizeVaultName(name);
    if (!vault) return { ok: false, error: 'Enter a valid name (a-z, 0-9, -, _).' };
    try {
      // Account comes from the token; the create API takes just { name } (no sub in the URL).
      const r = await requestUrl({
        url: `${API_ORIGIN}/api/memories`,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: vault }),
        throw: false,
      });
      if (r.status === 200 || r.status === 201) {
        this.resolver.invalidate(); // so the new memory shows up on the next list
        return { ok: true, vault };
      }
      if (r.status === 404 || r.status === 405 || r.status === 503)
        return { ok: false, error: 'Creating memories is not available on the server yet.' };
      const body = safeJson(r.text) as { error?: { message?: string } } | null;
      return { ok: false, error: body?.error?.message ?? `Create failed (HTTP ${r.status})` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  defaultVaultName(): string {
    return normalizeVaultName(this.app.vault.getName()) || 'personal';
  }

  /** Set the memory this vault syncs into, persist, refresh the UI, then auto-sync. */
  async selectVault(name: string): Promise<void> {
    this.settings.vault = name;
    await this.saveSettings();
    new Notice(`Agentage memory: ${name}`);
    this.onAuthChanged(); // re-render settings + status bar
    this.autoSyncOnReady(true); // memory chosen -> auto-sync + show the popup
  }

  currentVault(): string {
    return this.settings.vault;
  }

  /** Select a memory and sync it via the both-way count popup (the chooser's sync buttons). */
  async syncVault(name: string): Promise<void> {
    this.settings.vault = name;
    await this.saveSettings();
    this.onAuthChanged();
    this.autoSyncOnReady(true); // show the both-way count popup + sync (was: silent sync + Notice)
  }

  /** Open the memory chooser popup (pick existing or create new). */
  chooseMemory(): void {
    openMemoryChooser(this.app, this);
  }

  // --- auth (SettingsHost) ---
  openSignIn(): void {
    void this.auth.startSignIn();
  }
  isSignedIn(): boolean {
    return this.auth.isSignedIn();
  }
  async disconnect(): Promise<void> {
    await this.auth.disconnect();
    // Keep the selected memory across logout/login (persisted in data.json) so the next
    // sign-in resumes the same memory with no re-pick. A deleted/renamed memory is caught
    // at sync time (resolution + push), not by forgetting the choice here.
    this.lastVault = undefined;
    await this.saveSettings();
    this.refreshStatus();
  }

  // Git fs runs over Obsidian's vault adapter on BOTH desktop and mobile (the proven
  // obsidian-git pattern): the whole vault is the worktree, `.git` lives inside it,
  // paths are vault-relative (dir=''). We do NOT use node:fs — a native
  // `import('node:fs')` does not resolve in Obsidian's Electron renderer, which silently
  // killed every sync right after host-resolve (resolve 200, then zero git requests).
  private buildController(): SyncController {
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
    if (!token) return { ok: false, message: 'Sign in to Agentage first.' };
    let remote = this.settings.origin.remote.trim();
    const managed = !remote || remote === 'agentage';
    const chosen = normalizeVaultName(this.settings.vault);
    // In managed mode the user must pick a memory explicitly — never guess which one to
    // write to. No selection → open the chooser instead of syncing.
    if (managed && !chosen) {
      this.chooseMemory();
      return { ok: false, message: 'Opening the memory picker. Choose one to sync into.' };
    }
    let syncedVault = chosen || this.vaultNameOf();
    if (managed) {
      try {
        const res = await this.resolver.resolve(token);
        syncedVault = chosen;
        remote = buildRepoUrl(res.gitEndpoint, syncedVault);
      } catch (e) {
        return {
          ok: false,
          message: `Couldn't reach the agentage sync host: ${(e as Error).message}`,
        };
      }
    }
    this.lastVault = syncedVault; // so "Open dashboard" points at the vault we actually synced
    const ctrl = this.buildController();
    try {
      const r = await ctrl.syncNow({ url: remote, token });
      if (r.action === 'blocked') return { ok: false, message: r.message ?? 'blocked' };
      if (r.conflicted.length)
        return {
          ok: false,
          message: `Conflicts in ${r.conflicted.length} file(s) — see "Agentage Sync Conflicts".`,
        };
      // Unmergeable history (criss-cross): not pushed, no per-file markers — surface the reason.
      if (!r.pushed && r.message) return { ok: false, message: r.message };
      const bits = [r.action, r.committed ? 'committed' : '', r.pushed ? 'pushed' : ''].filter(
        Boolean
      );
      return { ok: true, message: `${syncedVault}: ${bits.join(' + ')}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  // Resolve the managed remote URL for the chosen memory (shared by the preview).
  private async resolvedRemote(token: string): Promise<string | null> {
    let remote = this.settings.origin.remote.trim();
    const managed = !remote || remote === 'agentage';
    const chosen = normalizeVaultName(this.settings.vault);
    if (managed && !chosen) return null;
    if (managed) remote = buildRepoUrl((await this.resolver.resolve(token)).gitEndpoint, chosen);
    return remote;
  }

  // Non-mutating preview of the next sync (file counts each way) for the popup.
  private async previewSync(): Promise<SyncPreview> {
    const token = await this.auth.getValidToken();
    if (!token) return { incoming: 0, outgoing: 0, firstSync: true };
    const remote = await this.resolvedRemote(token);
    if (!remote) return { incoming: 0, outgoing: 0, firstSync: true };
    return this.buildController().preview({ url: remote, token });
  }

  // Auto-sync once signed in WITH a memory chosen. `withModal` shows the file-count
  // popup (on sign-in / memory pick); silent on startup. Skips if a sync is in flight.
  private autoSyncOnReady(withModal: boolean): void {
    if (!this.isSignedIn() || this.needsMemory() || this.syncState === 'syncing') return;
    if (withModal) {
      openSyncPreview(
        this.app,
        () => this.previewSync(),
        () => this.syncNow()
      );
    } else {
      void this.syncNow().then((r) => {
        if (!r.ok) new Notice(`Agentage Sync: ${r.message}`);
      });
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
