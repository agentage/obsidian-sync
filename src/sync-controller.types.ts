import type { App, EventRef } from 'obsidian';
import type { AgentageMemorySettings } from './settings';
import type { BasicCreds, SecretStore } from './credentials';
import type { SyncBootstrap } from './bootstrap';

/** Obsidian capabilities the controller needs, injected by the plugin shell. */
export interface SyncDeps {
  app: App;
  secrets: SecretStore;
  load: () => Promise<unknown>;
  save: (data: unknown) => Promise<void>;
  /** Registers an Obsidian event so the plugin cleans it up on unload. */
  registerEvent: (ref: EventRef) => void;
  statusBar: HTMLElement;
  /**
   * Whether the user is signed in. Gates replication so a fresh / signed-out
   * install makes no unsolicited network calls (Obsidian Developer Policy).
   */
  isSignedIn: () => boolean;
  /**
   * Fetch the per-tenant cloud sync target + short-lived bearer from
   * `/api/sync/bootstrap` (refreshed on expiry by the controller), or null when
   * unavailable. Omitted in local-dev / e2e (Basic-creds path). Wired in main.ts.
   */
  syncBootstrap?: () => Promise<SyncBootstrap | null>;
}

/** The controller's public contract — what `main.ts` and the settings tab drive. */
export interface SyncController {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Re-evaluate the replication gate (e.g. after sign-in/out changes it). */
  refreshReplication(): void;
  pushCurrentNote(): Promise<void>;
  getSettings(): AgentageMemorySettings;
  getBasicCreds(): BasicCreds;
  setUsername(value: string): void;
  setPassword(value: string): void;
  setServerUrl(value: string): void;
  setDbName(value: string): void;
  setAuthBase(value: string): void;
  setAnonKey(value: string): void;
}
