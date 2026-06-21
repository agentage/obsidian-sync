// Token persistence over a SecretStore (Obsidian secretStorage / localStorage), never
// vaults.json. Pure over the adapter → unit-tested with an in-memory fake.
import type { TokenSet } from './oauth';

export interface SecretStore {
  get(id: string): string | null;
  set(id: string, value: string): void;
}

export const ACCESS_TOKEN_SECRET = 'agentage-memory-access-token';
export const REFRESH_TOKEN_SECRET = 'agentage-memory-refresh-token';
export const EXPIRES_AT_SECRET = 'agentage-memory-token-expires-at';
export const CLIENT_ID_SECRET = 'agentage-memory-oauth-client-id';

function saveSecretTokens(store: SecretStore, t: TokenSet): void {
  store.set(ACCESS_TOKEN_SECRET, t.accessToken);
  store.set(REFRESH_TOKEN_SECRET, t.refreshToken);
  store.set(EXPIRES_AT_SECRET, String(t.expiresAt));
}

function loadSecretTokens(store: SecretStore): TokenSet | null {
  const accessToken = store.get(ACCESS_TOKEN_SECRET);
  const refreshToken = store.get(REFRESH_TOKEN_SECRET);
  if (!accessToken || !refreshToken) return null;
  const expiresAt = Number(store.get(EXPIRES_AT_SECRET));
  return { accessToken, refreshToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 };
}

function clearSecretTokens(store: SecretStore): void {
  // secretStorage/localStorage have no delete here → blank the values.
  store.set(ACCESS_TOKEN_SECRET, '');
  store.set(REFRESH_TOKEN_SECRET, '');
  store.set(EXPIRES_AT_SECRET, '');
  store.set(CLIENT_ID_SECRET, '');
}

function getClientId(store: SecretStore): string | null {
  const v = store.get(CLIENT_ID_SECRET);
  return v && v.length > 0 ? v : null;
}
function setClientId(store: SecretStore, id: string): void {
  store.set(CLIENT_ID_SECRET, id);
}

export interface AuthJsonWriter {
  write(state: { clientId: string; tokens: TokenSet }): Promise<void>;
  clear(): Promise<void>;
}

export interface AuthStore {
  load(): TokenSet | null;
  getClientId(): string | null;
  setClientId(id: string): void;
  save(t: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

/** authJson is null on mobile / no-FS (secretStorage only). */
export function createAuthStore(secrets: SecretStore, authJson: AuthJsonWriter | null): AuthStore {
  return {
    load: () => loadSecretTokens(secrets),
    getClientId: () => getClientId(secrets),
    setClientId: (id) => setClientId(secrets, id),
    async save(t) {
      saveSecretTokens(secrets, t);
      const clientId = getClientId(secrets);
      if (authJson && clientId) await authJson.write({ clientId, tokens: t });
    },
    async clear() {
      clearSecretTokens(secrets);
      if (authJson) await authJson.clear();
    },
  };
}
