import type { App, EventRef } from 'obsidian';
import type { AgentageMemorySettings } from './settings';
import type { BasicCreds, SecretStore } from './credentials';

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

/** The controller's public contract — what `main.ts` and the settings tab drive. */
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
