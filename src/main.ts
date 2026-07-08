import { FileSystemAdapter, Menu, Notice, Platform, Plugin, TFile, requestUrl } from 'obsidian';
import {
  type AgentageMemorySettings,
  type VaultInfo,
  type VaultListResult,
  DEFAULT_SETTINGS,
  PROD_SITE_FQDN,
  normalizeVaultName,
  resolveSiteFqdn,
} from './settings';
import { AgentageMemorySettingTab, type SettingsHost } from './settings-tab';
import { applyVaultsConfig, type ApplyResult } from './vaults-config';
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
import { startLoopbackServer } from './auth/loopback-server';
import type { HttpPost } from './auth/oauth';
import type { GetJson } from './auth/discovery';
import { HostResolver, channelForVault, type SyncResolution } from './resolve-host';
import { openMemoryChooser } from './memory-chooser';
import { openActionsMenu, type PluginAction } from './actions-menu';
import { openSyncPreview, type SyncPreview } from './sync-preview-modal';
import { CouchSync, type CouchAuthorize } from './couch/couch-sync';
import { CouchChannel } from './couch/couch-channel';
import { CouchState } from './couch/couch-state';
import { CouchTokenClient, type CouchTokenPost } from './couch/couch-token';

// Single-host: every origin derives from the site FQDN. Precedence: the persisted
// `siteFqdn` setting (non-empty) > the AGENTAGE_SITE_FQDN env var (desktop only, same
// pattern as AGENTAGE_CONFIG_DIR) > prod. Snapshotted once per session at load; changing
// the setting needs an Obsidian restart because tokens + resolver are host-bound.
const ENV_SITE_FQDN = typeof process !== 'undefined' ? process.env?.AGENTAGE_SITE_FQDN : undefined;

// Status-bar sync state. Couch is the only device channel; 'conflict' is retained as a distinct
// error tone for parity with the status dot even though the couch channel resolves conflicts server-side.
type SyncStatus = 'idle' | 'syncing' | 'error' | 'conflict';

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
// (token in secretStorage/localStorage + ~/.agentage/auth.json) + live CouchDB sync.
export default class AgentageMemoryPlugin extends Plugin implements SettingsHost {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;
  isDesktop = Platform.isDesktopApp;
  // The host in effect this session (resolved once at load, after settings are read).
  private activeFqdn = PROD_SITE_FQDN;
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
  // Couch channel (discovery-driven): holds the one live controller per couch-channel memory,
  // rebuilt on a memory switch and torn down on a git-route sync / sign-out (see CouchChannel).
  private readonly couchChannel = new CouchChannel();
  private couchWired = false;
  private couchTokenPost!: CouchTokenPost;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.activeFqdn = resolveSiteFqdn(this.settings.siteFqdn, ENV_SITE_FQDN);
    if (this.activeFqdn !== PROD_SITE_FQDN)
      console.warn(`[Agentage Sync] non-production host active: ${this.activeFqdn}`);
    this.buildAuth();
    await this.hydrateAuth();

    this.settingTab = new AgentageMemorySettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerObsidianProtocolHandler(CALLBACK_ACTION, (params) => {
      console.debug('[Agentage Sync] OAuth callback received', { hasCode: !!params.code });
      // Re-render + the sync popup are driven by auth-flow's onChange/onSignedIn, so the
      // loopback path (which never hits this handler) gets the popup too.
      void this.auth.handleCallback(params);
    });

    // Ribbon + command open a modal action-picker (Sync now / Choose memory / dashboard).
    // Kept alongside the status-bar dot so the same actions survive when there's no status
    // bar (the mobile case, once mobile is re-enabled - desktop-only for now).
    this.addRibbonIcon('network', 'Agentage Sync', () => this.openActions());
    const sb = this.addStatusBarItem();
    this.statusBar = sb;
    sb.addClass('ams-statusbar', 'mod-clickable');
    // A REAL child element - an empty status-bar item (only a ::before) is hidden by Obsidian.
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

  // Live replication for the couch channel: push on md edits, pull on an interval. Registered
  // ONCE (Obsidian ties registerEvent/registerInterval to unload); handlers delegate to the
  // current per-memory controller, so a memory switch repoints without re-registering.
  private wireCouchEvents(): void {
    if (this.couchWired) return;
    this.couchWired = true;
    const onMd = (cb: (path: string) => void) => (f: unknown) => {
      if (f instanceof TFile && f.extension === 'md') cb(f.path);
    };
    this.registerEvent(
      this.app.vault.on(
        'modify',
        onMd((p) => void this.couchChannel.pushFileLive(p))
      )
    );
    this.registerEvent(
      this.app.vault.on(
        'create',
        onMd((p) => void this.couchChannel.pushFileLive(p))
      )
    );
    this.registerEvent(
      this.app.vault.on(
        'delete',
        onMd((p) => void this.couchChannel.removeFile(p))
      )
    );
    this.registerEvent(
      this.app.vault.on('rename', (f, oldPath) => {
        if (f instanceof TFile && f.extension === 'md') {
          void this.couchChannel.removeFile(oldPath);
          void this.couchChannel.pushFileLive(f.path);
        }
      })
    );
    // Tick = flush any queued (failed) pushes/deletes, then pull. A torn-down channel no-ops.
    this.registerInterval(window.setInterval(() => void this.couchChannel.tick(), 2000));
  }

  /** Sync a couch-channel memory: discovery already resolved endpoint/db/tokenUrl; mint the
   * per-memory JWT on demand (cached, re-minted on expiry/401) and replicate the thin-client
   * doc model against it. One live controller per memory; the server bridge commits couch -> git. */
  private async couchSyncNow(
    ch: { endpoint: string; db: string; tokenUrl: string },
    memory: string
  ): Promise<{ ok: boolean; message: string }> {
    const couch = this.couchChannel.for(memory, () => this.buildCouchSync(ch, memory));
    this.wireCouchEvents();
    this.setStatusBar('syncing');
    // CouchSync.syncNow is resilient (records, never throws): a failed side comes back as `error`.
    const r = await couch.syncNow();
    if (r.error) {
      this.setStatusBar('error', r.error);
      return { ok: false, message: r.error };
    }
    this.setStatusBar('idle');
    return { ok: true, message: `${memory}: couch synced` };
  }

  /** Build a CouchSync for `memory`: mint the per-memory JWT on demand (cached, re-minted on
   * expiry/401) + persist the pull cursor + push-rev cache + pending queues per (host, memory)
   * through data.json, so a reload resumes instead of re-pulling from seq 0. */
  private buildCouchSync(
    ch: { endpoint: string; db: string; tokenUrl: string },
    memory: string
  ): CouchSync {
    const tokenClient = new CouchTokenClient(
      ch.tokenUrl,
      memory,
      this.couchTokenPost,
      () => this.auth.getValidToken(),
      () => Date.now()
    );
    const authorize: CouchAuthorize = () => tokenClient.token();
    const state = this.couchStateFor(memory);
    return new CouchSync(
      this.app.vault,
      { endpoint: ch.endpoint, db: ch.db },
      authorize,
      () => tokenClient.invalidate(),
      state,
      (m) => console.debug('[Agentage Couch]', m)
    );
  }

  /** The persisted couch state for `memory`, keyed by (host, memory). Loaded the same way for
   * the live controller and the offline preview count, so both read the same push-rev cache. */
  private couchStateFor(memory: string): CouchState {
    const key = `${this.activeFqdn}:${memory}`;
    return new CouchState(
      () => this.settings.couchState[key],
      async (s) => {
        this.settings.couchState[key] = s;
        await this.saveSettings();
      }
    );
  }

  // --- site host (SettingsHost) ---
  /** The host every origin is derived from this session. */
  activeSiteFqdn(): string {
    return this.activeFqdn;
  }
  private origin(sub: string): string {
    return `https://${sub}.${this.activeFqdn}`;
  }

  private buildAuth(): void {
    // Token store: an in-memory cache (always works in-session) mirrored to Obsidian's
    // encrypted secretStorage, never data.json/vaults.json. secretStorage can THROW when
    // the OS keyring is unavailable (common on headless/keyring-less Linux) - we log and
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
      ? createAuthJsonWriter({
          configDirSetting: this.settings.configDir,
          siteFqdn: this.activeFqdn,
        })
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
      authOrigin: () => this.origin('auth'),
      notify: (m) => new Notice(m),
      openExternal: (url) => {
        console.debug('[Agentage Sync] opening authorize URL in browser');
        window.open(url, '_blank');
      },
      now: () => Date.now(),
      onChange: () => this.onAuthChanged(),
      // Fires on any completed sign-in (loopback OR obsidian://): auto-sync + show the popup.
      onSignedIn: () => this.autoSyncOnReady(true),
      // RFC 8252: desktop signs in via a 127.0.0.1 listener (snap/flatpak Obsidian drop
      // obsidian:// callbacks); without the factory (mobile) auth-flow uses the deep link.
      loopback: this.isDesktop ? () => startLoopbackServer() : undefined,
    });
    this.resolver = new HostResolver(
      this.origin('sync'),
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
    // Mint the per-memory couch JWT: POST the plugin's OAuth bearer to the resolved
    // couch_token_url; the auth service is the sole minter (CouchTokenClient caches it).
    this.couchTokenPost = async (url, body, bearer) => {
      const res = await requestUrl({
        url,
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body,
        throw: false,
      });
      return { status: res.status, json: safeJson(res.text) };
    };
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
    if (state.siteFqdn && state.siteFqdn !== this.activeFqdn) {
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
    // Auto sign-out funnels here (not disconnect); drop the live couch controller so a new user reuses no stale db.
    if (!this.auth.isSignedIn()) this.couchChannel.clear();
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
      tip = 'Agentage Sync - not signed in. Click to sign in.';
    } else if (erroring) {
      tone = 'red';
      tip = `Agentage Sync - ${this.syncState}${this.syncMsg ? `: ${this.syncMsg}` : ''}. Click for options.`;
    } else if (this.syncState === 'syncing') {
      tone = 'green';
      tip = 'Agentage Sync - syncing… Click for options.';
    } else if (!hasMemory) {
      tone = 'amber';
      tip = 'Agentage Sync - signed in. Choose a memory to sync into. Click to choose.';
    } else {
      tone = 'green';
      tip = `Agentage Sync - ready (${this.settings.vault}). Click for options.`;
    }
    this.statusDot.removeClass('is-gray', 'is-amber', 'is-green', 'is-red');
    this.statusDot.addClass(`is-${tone}`);
    // A visible label for the two states that need a user action (not just a tooltip).
    const label = tone === 'gray' ? 'Sign in' : tone === 'amber' ? 'Choose Memory' : '';
    // A non-prod host stays visible in the status bar so dev can't be mistaken for prod.
    const host = this.activeFqdn === PROD_SITE_FQDN ? '' : this.activeFqdn;
    if (host) tip = `${tip} Host: ${host}.`;
    this.statusEl?.setText(host ? (label ? `${label} · ${host}` : host) : label);
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
    const base = `${this.origin('dashboard')}/memories`;
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
        url: `${this.origin('api')}/api/memories`,
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
   * the sync channel never creates memories implicitly - R14). */
  async createVault(name: string): Promise<{ ok: boolean; vault?: string; error?: string }> {
    const token = await this.auth.getValidToken();
    if (!token) return { ok: false, error: 'Sign in to Agentage first.' };
    const vault = normalizeVaultName(name);
    if (!vault) return { ok: false, error: 'Enter a valid name (a-z, 0-9, -, _).' };
    try {
      // Account comes from the token; the create API takes just { name } (no sub in the URL).
      const r = await requestUrl({
        url: `${this.origin('api')}/api/memories`,
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
    // Stop any live couch controller so it can't keep replicating into a signed-out vault.
    this.couchChannel.clear();
    // Keep the selected memory across logout/login (persisted in data.json) so the next
    // sign-in resumes the same memory with no re-pick. A deleted/renamed memory is caught
    // at sync time (resolution + push), not by forgetting the choice here.
    this.lastVault = undefined;
    await this.saveSettings();
    this.refreshStatus();
  }

  // The user-facing message shown when a chosen memory has not been migrated to the couch
  // channel yet. Surfaced as a Notice + a red status dot, never a silent no-op.
  private static readonly NOT_ON_COUCH =
    'This memory is not on the new sync channel yet - server update pending.';

  async syncNow(): Promise<{ ok: boolean; message: string }> {
    const token = await this.auth.getValidToken();
    if (!token) return { ok: false, message: 'Sign in to Agentage first.' };
    const chosen = normalizeVaultName(this.settings.vault);
    // Couch is the only device channel: the user must pick a memory explicitly - never guess
    // which one to write to. No selection → open the chooser instead of syncing.
    if (!chosen) {
      this.chooseMemory();
      return { ok: false, message: 'Opening the memory picker. Choose one to sync into.' };
    }
    let res: SyncResolution;
    try {
      res = await this.resolver.resolve(token);
    } catch (e) {
      this.setStatusBar('error', (e as Error).message);
      return {
        ok: false,
        message: `Couldn't reach the agentage sync host: ${(e as Error).message}`,
      };
    }
    // Exactly one channel per memory. A memory the server advertises on the couch channel syncs
    // live; a memory NOT yet advertised is an explicit error (server flip pending), never git.
    const ch = channelForVault(res, chosen);
    if (ch.channel !== 'couch') {
      this.couchChannel.clear(); // stop replicating the previous memory into this folder
      this.setStatusBar('error', AgentageMemoryPlugin.NOT_ON_COUCH);
      new Notice(`Agentage Sync: ${AgentageMemoryPlugin.NOT_ON_COUCH}`);
      return { ok: false, message: AgentageMemoryPlugin.NOT_ON_COUCH };
    }
    this.lastVault = chosen; // so "Open dashboard" points at the memory we actually synced
    return this.couchSyncNow(ch, chosen);
  }

  // Non-mutating preview of the next sync for the popup: the HONEST couch outgoing count = local
  // md files whose content-rev differs from (or is absent from) the chosen memory's push-rev cache,
  // plus cached paths deleted locally. On a fresh memory (empty cache) that is EVERY md file - so
  // the popup no longer says "0 to send" before the first push. Computed with no controller + no
  // network, reusing the exact rev source pushAll uses (CouchSync.countOutgoing). firstSync = no
  // memory chosen / not signed in yet, so nothing to preview.
  private async previewSync(): Promise<SyncPreview> {
    const chosen = normalizeVaultName(this.settings.vault);
    const token = await this.auth.getValidToken();
    if (!token || !chosen) return { pending: 0, firstSync: true };
    const pending = await CouchSync.countOutgoing(this.app.vault, this.couchStateFor(chosen));
    return { pending, firstSync: false };
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
    // Fresh object so mutating couch state never aliases the shared DEFAULT_SETTINGS.
    this.settings.couchState = { ...(data?.couchState ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
