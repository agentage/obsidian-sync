/**
 * The plugin's sync core, as a closure factory. All mutable state (settings,
 * creds, the live replication handle, layout-ready flag) lives in closure
 * variables rather than `this` fields, so `main.ts` stays a thin Obsidian
 * adapter. Obsidian capabilities are injected via `SyncDeps`, keeping this
 * module's coupling explicit.
 */
import { type App, type EventRef, Notice, TFile, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, normalizeServerUrl, type AgentageMemorySettings } from './settings';
import {
  destroyLocalDb,
  getAllLocalDocs,
  getLocalDb,
  pushNoteViaPouch,
  resolveConflictedDoc,
  startContinuousSync,
  upsertNote,
  type PushCreds,
  type ReplicationHandle,
  type SyncChange,
} from './pouch';
import { obsidianFetchForPouch } from './obsidian-fetch';
import { basicAuthProvider, type AuthProvider } from './auth';
import {
  DEFAULT_BASIC_CREDS,
  PASSWORD_SECRET,
  USERNAME_SECRET,
  resolveBasicCreds,
  stripLegacyCreds,
  type BasicCreds,
  type SecretStore,
} from './credentials';
import { statusDisplay, type StatusState } from './status';
import { createEchoSuppress } from './echo-suppress';
import { applyDocToVault, type VaultGateway } from './apply-doc';
import { obsidianVaultGateway } from './obsidian-vault-gateway';
import { notesToSeed } from './seed';
import { conflictSidecarPath } from './conflict';
import { describeErr } from './errors';
import { handleNoteChange, handleNoteDelete, handleNoteRename } from './vault-events';

/** Obsidian capabilities the controller needs, injected by the plugin shell. */
export interface SyncDeps {
  app: App;
  secrets: SecretStore;
  load: () => Promise<unknown>;
  save: (data: unknown) => Promise<void>;
  /** Registers an Obsidian event so the plugin cleans it up on unload. */
  registerEvent: (ref: EventRef) => void;
  statusBar: HTMLElement;
}

export interface SyncController {
  start(): Promise<void>;
  stop(): Promise<void>;
  pushCurrentNote(): Promise<void>;
  getSettings(): AgentageMemorySettings;
  getBasicCreds(): BasicCreds;
  setUsername(value: string): void;
  setPassword(value: string): void;
  setServerUrl(value: string): void;
  setDbName(value: string): void;
}

const DEFAULT_DB_NAME = 'agentage-memory';

export function createSyncController(deps: SyncDeps): SyncController {
  const { app, secrets, load, save, registerEvent, statusBar } = deps;
  const echo = createEchoSuppress();
  const gateway: VaultGateway = obsidianVaultGateway(app);

  let settings: AgentageMemorySettings = DEFAULT_SETTINGS;
  let basicCreds: BasicCreds = DEFAULT_BASIC_CREDS;
  let replication: ReplicationHandle | null = null;
  let layoutReady = false;

  const persist = (): Promise<void> => save(settings);
  const creds = (): PushCreds => ({ serverUrl: settings.serverUrl, dbName: settings.dbName });
  const fetchImpl = (): ReturnType<typeof obsidianFetchForPouch> =>
    obsidianFetchForPouch(authProvider());
  const authProvider = (): AuthProvider =>
    basicAuthProvider(basicCreds.username, basicCreds.password);

  const setStatus = (state: StatusState, detail?: string): void => {
    const { iconId, tooltip, color } = statusDisplay(state, detail);
    statusBar.empty();
    const iconEl = statusBar.createSpan({ cls: 'agentage-memory-status-icon' });
    iconEl.dataset.status = state;
    iconEl.style.color = color;
    setIcon(iconEl, iconId);
    statusBar.title = tooltip;
  };

  const loadSettings = async (): Promise<void> => {
    const raw = ((await load()) as Record<string, unknown> | null) ?? {};
    // Migrate any plaintext creds from a pre-secretStorage data.json into the
    // secret store, seeding dev defaults when nothing is stored yet.
    basicCreds = resolveBasicCreds(secrets, { username: raw.username, password: raw.password });
    settings = Object.assign({}, DEFAULT_SETTINGS, stripLegacyCreds(raw));
    // Persist the stripped data.json so the plaintext creds don't linger.
    if ('username' in raw || 'password' in raw) await persist();
  };

  /**
   * Push pre-existing vault notes into the local replica so they replicate up.
   * The vault watcher's `create` events are ignored on load (Obsidian fires one
   * per existing file), so without this an already-populated vault — or one
   * enabled after startup — would never reach the cloud. Only missing/newer
   * notes are upserted, so re-running on each launch is cheap and idempotent.
   */
  const seedVault = async (): Promise<void> => {
    try {
      const db = getLocalDb();
      const notes = await gateway.listNotes();
      const todo = notesToSeed(notes, await getAllLocalDocs(db));
      for (const note of todo) {
        await upsertNote(db, note.path, note.content, note.mtime);
      }
      if (todo.length) {
        console.log(`[Agentage Memory] seeded ${todo.length} existing note(s) to local replica`);
      }
    } catch (err) {
      console.error('[Agentage Memory] seedVault failed:', describeErr(err));
    }
  };

  /**
   * Apply a pulled doc to the vault by its *winning* revision (read from the
   * local replica), never the change-feed body — under a conflict that body
   * can be the loser. Concurrent-edit losers are preserved as sidecar notes
   * (locked rule #3: keep both), created *without* echo suppression so the
   * watcher pushes them upstream — every device ends up with both edits.
   */
  const applyPulledDoc = async (id: string): Promise<void> => {
    try {
      const { deleted, content, losers } = await resolveConflictedDoc(getLocalDb(), id);
      await applyDocToVault(
        gateway,
        deleted ? { _id: id, _deleted: true } : { _id: id, content },
        echo
      );
      for (const loser of losers) {
        const path = conflictSidecarPath(id, loser.rev);
        if (!gateway.getFile(path)) {
          await gateway.create(path, loser.content);
        }
      }
    } catch (err) {
      console.error('[Agentage Memory] applyPulledDoc failed', id, describeErr(err));
    }
  };

  const onSyncChange = (info: SyncChange): void => {
    console.log(
      '[Agentage Memory] sync',
      info.direction,
      `read=${info.docsRead} written=${info.docsWritten}`
    );
    if (info.direction !== 'pull') return;
    for (const doc of info.docs) {
      void applyPulledDoc(doc._id);
    }
  };

  const stopReplication = (): void => {
    if (replication) {
      replication.cancel();
      replication = null;
    }
  };

  const restartReplication = (): void => {
    stopReplication();
    try {
      replication = startContinuousSync(creds(), fetchImpl(), {
        onActive: () => setStatus('active'),
        onPaused: (err) => {
          if (err) console.warn('[Agentage Memory] paused with transient error:', describeErr(err));
          setStatus('synced');
        },
        onChange: onSyncChange,
        onError: (err) => {
          console.error('[Agentage Memory] replication terminated:', describeErr(err));
          setStatus('error');
        },
      });
    } catch (err) {
      console.error('[Agentage Memory] startReplication failed:', describeErr(err));
      setStatus('error');
    }
  };

  const registerVaultEvents = (): void => {
    registerEvent(
      app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          void handleNoteChange(app, echo, file);
        }
      })
    );
    registerEvent(
      app.vault.on('create', (file) => {
        // Obsidian replays `create` for every existing file on vault load.
        // Skip that storm — `seedVault` handles pre-existing notes once.
        if (!layoutReady) return;
        if (file instanceof TFile && file.extension === 'md') {
          void handleNoteChange(app, echo, file);
        }
      })
    );
    registerEvent(
      app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          void handleNoteDelete(echo, file.path);
        }
      })
    );
    registerEvent(
      app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          void handleNoteRename(app, echo, file, oldPath);
        }
      })
    );
  };

  const pushCurrentNote = async (): Promise<void> => {
    const file = app.workspace.getActiveFile();
    if (!file) {
      new Notice('No active note.');
      return;
    }
    if (file.extension !== 'md') {
      new Notice('Active file is not a Markdown note.');
      return;
    }
    const content = await app.vault.read(file);
    try {
      const { id, rev } = await pushNoteViaPouch(
        creds(),
        file.path,
        content,
        file.stat.mtime,
        fetchImpl()
      );
      new Notice(`Pushed: ${id} (rev ${rev.split('-')[0]})`);
    } catch (err) {
      new Notice(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const start = async (): Promise<void> => {
    await loadSettings();
    setStatus('idle');
    registerVaultEvents();
    restartReplication();
    app.workspace.onLayoutReady(() => {
      layoutReady = true;
      void seedVault();
    });
    console.log('[Agentage Memory] loaded');
  };

  const stop = async (): Promise<void> => {
    stopReplication();
    await destroyLocalDb().catch((err) =>
      console.warn('[Agentage Memory] destroyLocalDb', describeErr(err))
    );
    console.log('[Agentage Memory] unloaded');
  };

  const setUsername = (value: string): void => {
    basicCreds = { ...basicCreds, username: value.trim() };
    secrets.set(USERNAME_SECRET, basicCreds.username);
    restartReplication();
  };

  const setPassword = (value: string): void => {
    basicCreds = { ...basicCreds, password: value };
    secrets.set(PASSWORD_SECRET, value);
    restartReplication();
  };

  const setServerUrl = (value: string): void => {
    settings = { ...settings, serverUrl: normalizeServerUrl(value) };
    void persist();
    restartReplication();
  };

  const setDbName = (value: string): void => {
    settings = { ...settings, dbName: value.trim() || DEFAULT_DB_NAME };
    void persist();
    restartReplication();
  };

  return {
    start,
    stop,
    pushCurrentNote,
    getSettings: () => settings,
    getBasicCreds: () => basicCreds,
    setUsername,
    setPassword,
    setServerUrl,
    setDbName,
  };
}
