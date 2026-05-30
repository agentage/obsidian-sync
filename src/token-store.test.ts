import { describe, expect, it } from 'vitest';
import { clearTokens, loadTokens, saveTokens } from './token-store';
import type { SecretStore } from './credentials';

function fakeStore(): SecretStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    get: (id) => (id in data ? data[id] : null),
    set: (id, value) => {
      data[id] = value;
    },
  };
}

const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1_700_000_000_000 };

describe('token-store', () => {
  it('round-trips a saved token set', () => {
    const store = fakeStore();
    saveTokens(store, tokens);
    expect(loadTokens(store)).toEqual(tokens);
  });

  it('returns null when nothing is stored', () => {
    expect(loadTokens(fakeStore())).toBeNull();
  });

  it('returns null after clearing', () => {
    const store = fakeStore();
    saveTokens(store, tokens);
    clearTokens(store);
    expect(loadTokens(store)).toBeNull();
  });

  it('treats a missing expiry as 0 (forces a refresh)', () => {
    const store = fakeStore();
    store.set('agentage-memory-access-token', 'at');
    store.set('agentage-memory-refresh-token', 'rt');
    expect(loadTokens(store)?.expiresAt).toBe(0);
  });
});
