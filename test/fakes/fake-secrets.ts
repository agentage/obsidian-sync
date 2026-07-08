// Lifted from src/auth/token-store.test.ts, extended with a throwing mode so a harness test
// can exercise main.ts's secretStorage-unavailable fallback (in-memory cache + auth.json).

export interface FakeSecretStorage {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export interface FakeSecrets extends FakeSecretStorage {
  /** Make every getSecret/setSecret throw, as a keyring-less desktop would. */
  breakKeyring(): void;
  /** Direct peek into the backing map (bypasses the throwing mode) for assertions. */
  peek(id: string): string | null;
}

// Shaped like Obsidian's app.secretStorage (getSecret/setSecret), which main.ts reads off app.
export const fakeSecrets = (): FakeSecrets => {
  const m = new Map<string, string>();
  let broken = false;
  return {
    getSecret: (id) => {
      if (broken) throw new Error('secretStorage unavailable');
      return m.get(id) ?? null;
    },
    setSecret: (id, value) => {
      if (broken) throw new Error('secretStorage unavailable');
      m.set(id, value);
    },
    breakKeyring: () => void (broken = true),
    peek: (id) => m.get(id) ?? null,
  };
};
