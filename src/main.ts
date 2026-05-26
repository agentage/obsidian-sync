import { Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl, type App } from 'obsidian';
import { DEFAULT_SETTINGS, normalizeServerUrl, type AgentageMemorySettings } from './settings';
import { pingServer } from './connection';
import {
  destroyLocalDb,
  getLocalDb,
  pushNoteViaPouch,
  startContinuousReplication,
  upsertNote,
  type PouchFetch,
  type PushCreds,
  type ReplicationHandle,
} from './pouch';

// Lucide icon id for the left-ribbon button. Ribbon icons are monochrome
// (theme-tinted); swap for a custom single-color SVG via addIcon() later.
const RIBBON_ICON = 'refresh-cw';

/** Extract useful fields from a PouchDB/fetch error so logs are not just `n`. */
function describeErr(err: unknown): Record<string, unknown> | string {
  if (err == null) return 'unknown';
  if (typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown>;
  return {
    name: e.name,
    message: e.message,
    status: e.status,
    reason: e.reason,
    error: e.error,
    docId: e.docId,
  };
}

/** Normalize the three valid `HeadersInit` shapes into a plain object. */
function headersToObject(h: HeadersInit | undefined | null): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/**
 * Wrap Obsidian's `requestUrl` to look like the browser `fetch` API and inject
 * Basic auth on every request. We bake auth here (rather than via PouchDB's
 * constructor `auth` option) because the `auth` option does not propagate to
 * the live replication `_changes` feed in PouchDB 7+.
 *
 * `requestUrl` bypasses CORS for us by running in the Electron main process.
 */
function obsidianFetchForPouch(creds: PushCreds): PouchFetch {
  const authHeader = 'Basic ' + btoa(`${creds.username}:${creds.password}`);
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = (init?.body as string) ?? undefined;
    const headers: Record<string, string> = {
      ...headersToObject(init?.headers),
      Authorization: authHeader,
    };
    // CouchDB rejects bodied requests without an explicit JSON Content-Type
    // (HTTP 415 'bad_content_type'). PouchDB usually sets this, but the
    // header survives only if we extract it as a plain object first.
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await requestUrl({ url, method, headers, body, throw: false });
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
}

// NOTE: Obsidian loads the entry plugin class as the module's DEFAULT export.
// This is the one place we use a default export (platform requirement);
// everything else in src/ uses named exports per the project conventions.
export default class AgentageMemoryPlugin extends Plugin {
  settings: AgentageMemorySettings = DEFAULT_SETTINGS;
  private replication: ReplicationHandle | null = null;
  private statusBar: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = this.addStatusBarItem();
    this.setStatus('idle');

    this.addRibbonIcon(
      RIBBON_ICON,
      'Agentage Memory',
      () =>
        new Notice('Agentage Memory: edits auto-sync; use the command palette to push manually.')
    );

    this.addCommand({
      id: 'push-current-note',
      name: 'Push current note to Agentage Memory',
      callback: async () => {
        await this.pushCurrentNote();
      },
    });

    this.addSettingTab(new AgentageMemorySettingTab(this.app, this));

    this.registerVaultEvents();
    this.startReplication();

    console.log('[Agentage Memory] loaded');
  }

  async onunload(): Promise<void> {
    this.stopReplication();
    // Free the local IndexedDB handle so a quick disable/enable cycle doesn't leak it.
    await destroyLocalDb().catch((err) => console.warn('[Agentage Memory] destroyLocalDb', err));
    console.log('[Agentage Memory] unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private creds(): PushCreds {
    return {
      serverUrl: this.settings.serverUrl,
      username: this.settings.username,
      password: this.settings.password,
    };
  }

  private setStatus(state: 'idle' | 'active' | 'synced' | 'error', detail?: string): void {
    if (!this.statusBar) return;
    const label = {
      idle: 'memory: idle',
      active: 'memory: syncing…',
      synced: 'memory: in sync',
      error: `memory: error${detail ? ` (${detail})` : ''}`,
    }[state];
    this.statusBar.setText(label);
  }

  /** Auto-push on every vault edit. Live replication handles the upstream push. */
  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          void this.onVaultNoteChanged(file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          void this.onVaultNoteChanged(file);
        }
      })
    );
  }

  private async onVaultNoteChanged(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      await upsertNote(getLocalDb(), file.path, content, file.stat.mtime);
    } catch (err) {
      console.error('[Agentage Memory] auto-upsert failed', file.path, err);
    }
  }

  startReplication(): void {
    this.stopReplication();
    try {
      this.replication = startContinuousReplication(
        this.creds(),
        obsidianFetchForPouch(this.creds()),
        {
          onActive: () => this.setStatus('active'),
          onPaused: (err) => {
            // PouchDB emits `paused` BOTH on a healthy idle ("in sync, waiting for
            // changes") AND on a transient hiccup that retry:true is about to
            // recover from. Treat both as "in sync" — only `onError` (below) is
            // a terminal failure that warrants the error indicator.
            if (err) {
              console.warn('[Agentage Memory] paused with transient error:', describeErr(err));
            }
            this.setStatus('synced');
          },
          onChange: (info) => console.log('[Agentage Memory] replicated batch', info),
          onError: (err) => {
            console.error('[Agentage Memory] replication terminated:', describeErr(err));
            this.setStatus('error');
          },
        }
      );
    } catch (err) {
      console.error('[Agentage Memory] startReplication failed:', describeErr(err));
      this.setStatus('error');
    }
  }

  stopReplication(): void {
    if (this.replication) {
      this.replication.cancel();
      this.replication = null;
    }
  }

  async pushCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('No active note.');
      return;
    }
    if (file.extension !== 'md') {
      new Notice('Active file is not a Markdown note.');
      return;
    }
    const content = await this.app.vault.read(file);
    try {
      const { id, rev } = await pushNoteViaPouch(
        this.creds(),
        file.path,
        content,
        file.stat.mtime,
        obsidianFetchForPouch(this.creds())
      );
      const shortRev = rev.split('-')[0];
      new Notice(`Pushed: ${id} (rev ${shortRev})`);
    } catch (err) {
      new Notice(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

class AgentageMemorySettingTab extends PluginSettingTab {
  private readonly plugin: AgentageMemoryPlugin;

  constructor(app: App, plugin: AgentageMemoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your Agentage Memory cloud endpoint. Leave the default unless told otherwise.')
      .addText((text) =>
        text
          .setPlaceholder('https://mcp.agentage.io')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = normalizeServerUrl(value);
            await this.plugin.saveSettings();
            this.plugin.startReplication();
          })
      );

    new Setting(containerEl)
      .setName('Username')
      .setDesc('CouchDB username (local dev only — moves to OAuth + secret storage later).')
      .addText((text) =>
        text
          .setPlaceholder('admin')
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value.trim();
            await this.plugin.saveSettings();
            this.plugin.startReplication();
          })
      );

    new Setting(containerEl)
      .setName('Password')
      .setDesc('CouchDB password (stored in plaintext data.json — local dev only).')
      .addText((text) => {
        text
          .setPlaceholder('agentage')
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
            this.plugin.startReplication();
          });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Ping the server URL to confirm it is reachable.')
      .addButton((btn) =>
        btn.setButtonText('Test').onClick(async () => {
          btn.setDisabled(true).setButtonText('Testing…');
          const r = await pingServer(this.plugin.settings.serverUrl, async (u) => {
            const res = await requestUrl({ url: u, method: 'GET', throw: false });
            return { status: res.status };
          });
          btn.setDisabled(false).setButtonText('Test');
          new Notice(
            r.ok
              ? `Connected (HTTP ${r.status})`
              : `Failed: ${r.error ?? `HTTP ${r.status ?? '?'}`}`
          );
        })
      );
  }
}
