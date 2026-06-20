import { FileSystemAdapter, Notice, Platform, Plugin, requestUrl, setIcon } from 'obsidian';
import type { FsClient, MergeDriverCallback } from 'isomorphic-git';
import { type AgentageMemorySettings, DEFAULT_SETTINGS, normalizeVaultName } from './settings';
import { AgentageMemorySettingTab, type SettingsHost } from './settings-tab';
import { applyVaultsConfig, type ApplyResult } from './vaults-config';
import { createGitClient } from './git/git-client';
import { requestUrlHttpClient } from './git/http-requesturl';
import { mergeNote } from './git/merge-note';
import { createSyncController, type SyncStatus } from './sync-controller';
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
    const secrets: SecretStore = {
      get: (id) => this.app.loadLocalStorage(id) as string | null,
      set: (id, v) => this.app.saveLocalStorage(id, v || undefined),
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

  /** Desktop git sync using node fs (the path covered by the unit/integration tests). */
  private async buildController() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const nodefs = (await import('node:fs')) as unknown as FsClient;
    const client = createGitClient({ fs: nodefs, http: requestUrlHttpClient }, agentageMergeDriver);
    return createSyncController({
      client,
      fs: nodefs,
      dir: adapter.getBasePath(),
      ignore: [this.app.vault.configDir],
      now: () => new Date().toISOString(),
      onStatus: (s, msg) => this.setStatusBar(s, msg),
    });
  }

  async syncNow(): Promise<{ ok: boolean; message: string }> {
    if (!this.isDesktop) return { ok: false, message: 'Sync is desktop-only for now.' };
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
    if (!ctrl) return { ok: false, message: 'No filesystem access (desktop only).' };
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
