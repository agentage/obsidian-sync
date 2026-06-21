import { describe, it, expect, vi } from 'vitest';
import { createAuthStore, type AuthJsonWriter, type SecretStore } from './token-store';
import type { TokenSet } from './oauth';

const fakeSecrets = (): SecretStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};
const T: TokenSet = { accessToken: 'AT', refreshToken: 'RT', expiresAt: 123 };

describe('token-store', () => {
  it('round-trips tokens + clientId; clear blanks them', async () => {
    const store = createAuthStore(fakeSecrets(), null);
    store.setClientId('cid');
    await store.save(T);
    expect(store.load()).toEqual(T);
    expect(store.getClientId()).toBe('cid');
    await store.clear();
    expect(store.load()).toBeNull();
    expect(store.getClientId()).toBeNull();
  });

  it('mirrors to auth.json on save/clear when a writer is present (with the clientId)', async () => {
    const authJson: AuthJsonWriter = {
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const store = createAuthStore(fakeSecrets(), authJson);
    store.setClientId('cid');
    await store.save(T);
    expect(authJson.write).toHaveBeenCalledWith({ clientId: 'cid', tokens: T });
    await store.clear();
    expect(authJson.clear).toHaveBeenCalled();
  });

  it('load returns null when a token is missing', () => {
    const s = fakeSecrets();
    s.set('agentage-memory-access-token', 'AT'); // no refresh
    expect(createAuthStore(s, null).load()).toBeNull();
  });
});
