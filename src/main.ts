import { FileSystemAdapter, Notice, Platform, Plugin, setIcon } from 'obsidian';
import type { FsClient, MergeDriverCallback } from 'isomorphic-git';
import { type AgentageMemorySettings, DEFAULT_SETTINGS, normalizeVaultName } from './settings';
import { AgentageMemorySettingTab, type SettingsHost } from './settings-tab';
import { applyVaultsConfig, type ApplyResult } from './vaults-config';
import { createGitClient } from './git/git-client';
import { requestUrlHttpClient } from './git/http-requesturl';
import { mergeNote } from './git/merge-note';
import { createSyncController, type SyncStatus } from './sync-controller';

const CONNECT_URL = 'https://agentage.io';
const TOKEN_KEY = 'agentage-sync:token';

// 3-way merge driver: split-YAML field-LWW + diff3 body (see git/merge-note).
const agentageMergeDriver: MergeDriverCallback = ({ contents }) => {
  const [base, ours, theirs] = contents;
  const { text, clean } = mergeNote(base, ours, theirs);
  return { cleanMerge: clean, mergedText: text };
};

// Agentage Sync plugin. Configuration page (writes ~/.agentage/vaults.json) + a
// desktop git sync (isomorphic-git over requestUrl). Sign-in/token capture (OAuth)
// and mobile (VaultFs) are later milestones; today a token is set in settings for testing.
export default class AgentageMemoryPlugin extends Plugin implements SettingsHost {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;
  isDesktop = Platform.isDesktopApp;
  private statusEl?: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AgentageMemorySettingTab(this.app, this));

    this.addRibbonIcon('refresh-cw', 'Agentage Sync', () => this.openSettings());
    const sb = this.addStatusBarItem();
    sb.addClass('ams-statusbar');
    setIcon(sb.createSpan({ cls: 'ams-sb-icon' }), 'refresh-cw');
    this.statusEl = sb.createSpan({ text: 'Agentage Sync' });

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => {
        void this.syncNow().then((r) => new Notice(`Agentage Sync: ${r.message}`));
      },
    });
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

  /** Absolute path of this vault's folder (desktop); falls back to the vault name. */
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

  openSignIn(): void {
    window.open(CONNECT_URL, '_blank');
    new Notice(
      'Opening agentage sign-in. Your token will be saved to ~/.agentage/auth.json (not vaults.json) when sign-in lands.'
    );
  }

  // --- testing token store (localStorage; real secretStorage/OAuth lands in M1) ---
  async setToken(token: string): Promise<void> {
    this.app.saveLocalStorage(TOKEN_KEY, token || undefined);
  }
  tokenSet(): boolean {
    return !!this.app.loadLocalStorage(TOKEN_KEY);
  }
  private getToken(): string | null {
    return this.app.loadLocalStorage(TOKEN_KEY) as string | null;
  }

  /** Desktop git sync using node fs (the path covered by the unit/integration tests). */
  private async buildController() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const dir = adapter.getBasePath();
    const nodefs = (await import('node:fs')) as unknown as FsClient;
    const client = createGitClient({ fs: nodefs, http: requestUrlHttpClient }, agentageMergeDriver);
    return createSyncController({
      client,
      fs: nodefs,
      dir,
      ignore: [this.app.vault.configDir],
      now: () => new Date().toISOString(),
      onStatus: (s, msg) => this.setStatusBar(s, msg),
    });
  }

  async syncNow(): Promise<{ ok: boolean; message: string }> {
    if (!this.isDesktop) return { ok: false, message: 'Sync is desktop-only for now.' };
    const token = this.getToken();
    if (!token) return { ok: false, message: 'Paste an access token in settings first.' };
    const remote = this.settings.origin.remote.trim();
    if (!remote || remote === 'agentage') {
      return {
        ok: false,
        message: 'Set a git remote URL in settings (the agentage remote resolver lands later).',
      };
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
