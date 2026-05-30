import { describe, expect, it } from 'vitest';
import { isUnconfiguredDefault, pingServer, shouldStartReplication } from './connection';
import { DEFAULT_SETTINGS } from './settings';

describe('pingServer', () => {
  it('returns ok when the server responds 2xx', async () => {
    const r = await pingServer('https://example.com', async () => ({ status: 200 }));
    expect(r).toEqual({ ok: true, status: 200 });
  });

  it('strips trailing slashes before appending /_up', async () => {
    let calledWith = '';
    await pingServer('https://example.com///', async (u) => {
      calledWith = u;
      return { status: 200 };
    });
    expect(calledWith).toBe('https://example.com/_up');
  });

  it('returns not-ok with status when the server responds non-2xx', async () => {
    const r = await pingServer('https://example.com', async () => ({ status: 503 }));
    expect(r).toEqual({ ok: false, status: 503 });
  });

  it('returns not-ok with error message when fetch throws', async () => {
    const r = await pingServer('https://example.com', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});

describe('isUnconfiguredDefault', () => {
  it('is true when the server URL is still the default cloud host', () => {
    expect(isUnconfiguredDefault(DEFAULT_SETTINGS.serverUrl, DEFAULT_SETTINGS.serverUrl)).toBe(
      true
    );
  });

  it('ignores trailing-slash / whitespace differences', () => {
    expect(
      isUnconfiguredDefault(`  ${DEFAULT_SETTINGS.serverUrl}/  `, DEFAULT_SETTINGS.serverUrl)
    ).toBe(true);
  });

  it('is false for a configured CouchDB host', () => {
    expect(isUnconfiguredDefault('http://localhost:5984', DEFAULT_SETTINGS.serverUrl)).toBe(false);
  });
});

describe('shouldStartReplication (no unsolicited network on load)', () => {
  const def = DEFAULT_SETTINGS.serverUrl;
  const real = 'http://localhost:5984';

  it('does NOT replicate on a fresh signed-out install (default host, no creds)', () => {
    expect(
      shouldStartReplication({
        serverUrl: def,
        defaultUrl: def,
        hasCreds: false,
        isSignedIn: false,
      })
    ).toBe(false);
  });

  it('does NOT replicate against the default host even when signed in', () => {
    expect(
      shouldStartReplication({ serverUrl: def, defaultUrl: def, hasCreds: false, isSignedIn: true })
    ).toBe(false);
  });

  it('does NOT replicate against the default host even with stray creds', () => {
    expect(
      shouldStartReplication({ serverUrl: def, defaultUrl: def, hasCreds: true, isSignedIn: false })
    ).toBe(false);
  });

  it('replicates against a real host with creds (local-dev / e2e path, not signed in)', () => {
    expect(
      shouldStartReplication({
        serverUrl: real,
        defaultUrl: def,
        hasCreds: true,
        isSignedIn: false,
      })
    ).toBe(true);
  });

  it('replicates against a real host when signed in without basic creds (bootstrap path)', () => {
    expect(
      shouldStartReplication({
        serverUrl: real,
        defaultUrl: def,
        hasCreds: false,
        isSignedIn: true,
      })
    ).toBe(true);
  });

  it('does NOT replicate against a real host with neither creds nor sign-in', () => {
    expect(
      shouldStartReplication({
        serverUrl: real,
        defaultUrl: def,
        hasCreds: false,
        isSignedIn: false,
      })
    ).toBe(false);
  });
});
