import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthJsonWriter, readAuthJsonState } from './auth-json';

let dir: string;
const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentage-auth-'));
  process.env.AGENTAGE_CONFIG_DIR = dir;
});
afterEach(() => {
  delete process.env.AGENTAGE_CONFIG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('auth-json (desktop, never vaults.json)', () => {
  it('writes auth.json (not vaults.json) atomically at mode 0600 with the CLI shape', async () => {
    const w = createAuthJsonWriter({ configDirSetting: '~/.agentage', siteFqdn: 'agentage.io' });
    await w.write({
      clientId: 'cid',
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9 },
    });
    expect(fs.existsSync(path.join(dir, 'vaults.json'))).toBe(false);
    const c = read();
    expect(c).toMatchObject({
      siteFqdn: 'agentage.io',
      clientId: 'cid',
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9 },
    });
    expect(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, 'auth.json.tmp'))).toBe(false); // atomic, no leftover
  });

  it('clear leaves only the siteFqdn', async () => {
    const w = createAuthJsonWriter({ configDirSetting: '~/.agentage', siteFqdn: 'agentage.io' });
    await w.write({
      clientId: 'cid',
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9 },
    });
    await w.clear();
    expect(read()).toEqual({ siteFqdn: 'agentage.io' });
  });

  it('readAuthJsonState round-trips what the writer wrote (desktop hydration source)', async () => {
    const w = createAuthJsonWriter({ configDirSetting: '~/.agentage', siteFqdn: 'agentage.io' });
    await w.write({
      clientId: 'cid',
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9 },
    });
    const state = await readAuthJsonState('~/.agentage');
    expect(state).toMatchObject({
      clientId: 'cid',
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9 },
    });
  });

  it('readAuthJsonState returns null when the file is absent or tokenless (no false sign-in)', async () => {
    expect(await readAuthJsonState('~/.agentage')).toBeNull(); // nothing written yet
    const w = createAuthJsonWriter({ configDirSetting: '~/.agentage', siteFqdn: 'agentage.io' });
    await w.write({
      clientId: 'cid',
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9 },
    });
    await w.clear(); // leaves only siteFqdn
    expect(await readAuthJsonState('~/.agentage')).toBeNull();
  });
});
