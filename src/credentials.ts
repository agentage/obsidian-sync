/**
 * Basic-auth credential storage. Credentials live in Obsidian's encrypted
 * `app.secretStorage` (since 1.11.4), never plaintext `data.json`. This module
 * is Obsidian-free so it stays unit-testable; `main.ts` adapts
 * `app.secretStorage` to the `SecretStore` shape.
 */

export interface BasicCreds {
  username: string;
  password: string;
}

/** Minimal view of Obsidian's `SecretStorage` — synchronous get/set by id. */
export interface SecretStore {
  get(id: string): string | null;
  set(id: string, value: string): void;
}

export const USERNAME_SECRET = 'agentage-memory-username';
export const PASSWORD_SECRET = 'agentage-memory-password';

/** Dev defaults match the local CouchDB shipped in docker-compose.yml. */
export const DEFAULT_BASIC_CREDS: BasicCreds = {
  username: 'admin',
  password: 'agentage',
};

/** Legacy plaintext creds that may still sit in a pre-secretStorage `data.json`. */
export interface LegacyCreds {
  username?: unknown;
  password?: unknown;
}

/**
 * Resolve the Basic creds, migrating any legacy plaintext `data.json` values
 * into the secret store on first run and seeding dev defaults when nothing is
 * stored yet. Writes through `store`, so the migration persists.
 */
export function resolveBasicCreds(store: SecretStore, legacy: LegacyCreds = {}): BasicCreds {
  return {
    username: resolveOne(store, USERNAME_SECRET, legacy.username, DEFAULT_BASIC_CREDS.username),
    password: resolveOne(store, PASSWORD_SECRET, legacy.password, DEFAULT_BASIC_CREDS.password),
  };
}

function resolveOne(store: SecretStore, id: string, legacy: unknown, fallback: string): string {
  const existing = store.get(id);
  if (existing !== null) return existing;
  const value = typeof legacy === 'string' && legacy.length > 0 ? legacy : fallback;
  store.set(id, value);
  return value;
}

/** Drop legacy plaintext credential keys from persisted settings data. */
export function stripLegacyCreds(data: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...data };
  delete clean.username;
  delete clean.password;
  return clean;
}
