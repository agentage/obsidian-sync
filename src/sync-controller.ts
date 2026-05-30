/**
 * The plugin's sync core, as a closure factory. All mutable state (settings,
 * creds, the live replication handle, layout-ready flag) lives in closure
 * variables rather than `this` fields, so `main.ts` stays a thin Obsidian
 * adapter. Obsidian capabilities are injected via `SyncDeps`; the inbound apply,
 * status rendering, and vault watching live in their own focused modules.
 */
import { DEFAULT_SETTINGS, normalizeServerUrl, type AgentageMemorySettings } from './settings';
import { destroyLocalDb, getLocalDb } from './pouch';
import { startContinuousSync, type ReplicationHandle, type SyncChange } from './replication';
import { obsidianFetchForPouch } from './obsidian-fetch';
import { basicAuthProvider, type AuthProvider } from './auth';
import {
  DEFAULT_BASIC_CREDS,
  PASSWORD_SECRET,
  USERNAME_SECRET,
  resolveBasicCreds,
  stripLegacyCreds,
  type BasicCreds,
} from './credentials';
import { type StatusState } from './status';
import { createEchoSuppress } from './echo-suppress';
import { type VaultGateway } from './apply-doc';
import { obsidianVaultGateway } from './obsidian-vault-gateway';
import { describeErr } from './errors';
import { applyPulledDoc, seedLocalReplica } from './inbound';
import { renderStatus } from './status-bar';
import { registerVaultWatchers } from './vault-watcher';
import { pushActiveNote } from './push-note';
import type { PushCreds } from './replication';
import type { SyncController, SyncDeps } from './sync-controller.types';

export type { SyncController, SyncDeps } from './sync-controller.types';

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
  const authProvider = (): AuthProvider =>
    basicAuthProvider(basicCreds.username, basicCreds.password);
  const fetchImpl = (): ReturnType<typeof obsidianFetchForPouch> =>
    obsidianFetchForPouch(authProvider());
  const setStatus = (state: StatusState, detail?: string): void =>
    renderStatus(statusBar, state, detail);

  const loadSettings = async (): Promise<void> => {
    const raw = ((await load()) as Record<string, unknown> | null) ?? {};
    // Migrate any plaintext creds from a pre-secretStorage data.json into the
    // secret store, seeding dev defaults when nothing is stored yet.
    basicCreds = resolveBasicCreds(secrets, { username: raw.username, password: raw.password });
    settings = Object.assign({}, DEFAULT_SETTINGS, stripLegacyCreds(raw));
    // Persist the stripped data.json so the plaintext creds don't linger.
    if ('username' in raw || 'password' in raw) await persist();
  };

  const seedVault = async (): Promise<void> => {
    try {
      await seedLocalReplica(getLocalDb(), gateway);
    } catch (err) {
      console.error('[Agentage Memory] seedVault failed:', describeErr(err));
    }
  };

  const applyPulled = async (id: string): Promise<void> => {
    try {
      await applyPulledDoc(getLocalDb(), gateway, echo, id);
    } catch (err) {
      console.error('[Agentage Memory] applyPulledDoc failed', id, describeErr(err));
    }
  };

  const onSyncChange = (info: SyncChange): void => {
    if (info.direction !== 'pull') return;
    for (const doc of info.docs) {
      void applyPulled(doc._id);
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

  const pushCurrentNote = (): Promise<void> => pushActiveNote(app, creds(), fetchImpl());

  const start = async (): Promise<void> => {
    await loadSettings();
    setStatus('idle');
    registerVaultWatchers({ app, echo, registerEvent, isLayoutReady: () => layoutReady });
    restartReplication();
    app.workspace.onLayoutReady(() => {
      layoutReady = true;
      void seedVault();
    });
  };

  const stop = async (): Promise<void> => {
    stopReplication();
    try {
      await destroyLocalDb();
    } catch (err) {
      console.warn('[Agentage Memory] destroyLocalDb', describeErr(err));
    }
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

  // Auth config feeds the OAuth flow, not replication — persist without restart.
  const setAuthBase = (value: string): void => {
    settings = { ...settings, authBase: normalizeServerUrl(value) };
    void persist();
  };

  const setAnonKey = (value: string): void => {
    settings = { ...settings, anonKey: value.trim() };
    void persist();
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
    setAuthBase,
    setAnonKey,
  };
}
