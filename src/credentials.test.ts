import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASIC_CREDS,
  PASSWORD_SECRET,
  USERNAME_SECRET,
  resolveBasicCreds,
  stripLegacyCreds,
  type SecretStore,
} from './credentials';

function fakeStore(
  seed: Record<string, string> = {}
): SecretStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    get: (id) => (id in data ? data[id] : null),
    set: (id, value) => {
      data[id] = value;
    },
  };
}

describe('resolveBasicCreds', () => {
  it('seeds dev defaults when nothing is stored', () => {
    const store = fakeStore();
    expect(resolveBasicCreds(store)).toEqual(DEFAULT_BASIC_CREDS);
    expect(store.data[USERNAME_SECRET]).toBe('admin');
    expect(store.data[PASSWORD_SECRET]).toBe('agentage');
  });

  it('returns stored secrets without overwriting them', () => {
    const store = fakeStore({ [USERNAME_SECRET]: 'me', [PASSWORD_SECRET]: 'hunter2' });
    expect(resolveBasicCreds(store, { username: 'legacy', password: 'old' })).toEqual({
      username: 'me',
      password: 'hunter2',
    });
  });

  it('migrates legacy plaintext creds into the store on first run', () => {
    const store = fakeStore();
    expect(resolveBasicCreds(store, { username: 'bob', password: 's3cret' })).toEqual({
      username: 'bob',
      password: 's3cret',
    });
    expect(store.data[USERNAME_SECRET]).toBe('bob');
    expect(store.data[PASSWORD_SECRET]).toBe('s3cret');
  });

  it('falls back to defaults for empty or non-string legacy values', () => {
    const store = fakeStore();
    expect(resolveBasicCreds(store, { username: '', password: 42 })).toEqual(DEFAULT_BASIC_CREDS);
  });
});

describe('stripLegacyCreds', () => {
  it('drops username and password, keeping everything else', () => {
    expect(stripLegacyCreds({ serverUrl: 'x', dbName: 'y', username: 'a', password: 'b' })).toEqual(
      { serverUrl: 'x', dbName: 'y' }
    );
  });

  it('does not mutate the input', () => {
    const input = { username: 'a', dbName: 'y' };
    stripLegacyCreds(input);
    expect(input.username).toBe('a');
  });
});
