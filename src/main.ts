import { FileSystemAdapter, Notice, Platform, Plugin, requestUrl, setIcon } from 'obsidian';
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
import { createAuthStore, type SecretStore } from './auth/token-store';
import { createAuthJsonWriter } from './auth/auth-json';
import type { HttpPost } from './auth/oauth';
import type { GetJson } from './auth/discovery';
import { HostResolver, buildRepoUrl } from './resolve-host';

const AUTH_ORIGIN = 'https://auth.agentage.io';
const SYNC_ORIGIN = 'https://sync.agentage.io';
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
  private statusEl?: HTMLElement;
  private settingTab?: AgentageMemorySettingTab;
  private auth!: AuthFlow;
  private resolver!: HostResolver;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.buildAuth();

    this.settingTab = new AgentageMemorySettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerObsidianProtocolHandler(
      CALLBACK_ACTION,
      (params) => void this.auth.handleCallback(params)
    );

    this.addRibbonIcon('refresh-cw', 'Agentage Sync', () => this.openSettings());
    const sb = this.addStatusBarItem();
    sb.addClass('ams-statusbar');
    setIcon(sb.createSpan({ cls: 'ams-sb-icon' }), 'refresh-cw');
    this.statusEl = sb.createSpan({ text: 'Agentage Sync' });

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.syncNow().then((r) => new Notice(`Agentage Sync: ${r.message}`)),
    });
  }

  private buildAuth(): void {
    // Tokens live in Obsidian's encrypted secretStorage (the proven backing from
    // the archived plugin), never data.json/vaults.json. Defensive: if a build's
    // getSecret is async (returns a Promise), get() yields null instead of throwing.
    const ss = (
      this.app as unknown as {
        secretStorage?: {
          getSecret(id: string): unknown;
          setSecret(id: string, value: string): unknown;
        };
      }
    ).secretStorage;
    const secrets: SecretStore = {
      get: (id) => {
        try {
          const v = ss?.getSecret(id);
          return typeof v === 'string' ? v : null;
        } catch {
          return null;
        }
      },
      set: (id, value) => {
        try {
          const r = ss?.setSecret(id, value);
          if (r instanceof Promise) void r.catch(() => undefined);
        } catch {
          /* secretStorage unavailable */
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
      openExternal: (url) => window.open(url, '_blank'),
      now: () => Date.now(),
      onChange: () => this.settingTab?.display(),
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
    if (!this.statusEl) return;
    const label: Record<SyncStatus, string> = {
      idle: 'Agentage Sync',
      syncing: 'Agentage Sync: syncing…',
      error: 'Agentage Sync: error',
      conflict: 'Agentage Sync: conflict',
    };
    this.statusEl.setText(msg ? `${label[s]} (${msg})` : label[s]);
  }

  private openSettings(): void {
    const app = this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    };
    app.setting?.open?.();
    app.setting?.openTabById?.(this.manifest.id);
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
