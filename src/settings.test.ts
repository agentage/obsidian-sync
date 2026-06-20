import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  buildVaultsConfig,
  normalizeRemote,
  normalizeVaultName,
  parseIgnore,
  validateSettings,
  type AgentageMemorySettings,
} from './settings';

const s = (over: Partial<AgentageMemorySettings> = {}): AgentageMemorySettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

describe('settings helpers', () => {
  it('normalizeVaultName → safe lowercase segment', () => {
    expect(normalizeVaultName('My Vault!')).toBe('my-vault');
    expect(normalizeVaultName('  a__b  ')).toBe('a__b');
    expect(normalizeVaultName('!!!')).toBe('');
  });

  it('normalizeRemote trims + drops trailing slashes', () => {
    expect(normalizeRemote('  https://x/ ')).toBe('https://x');
  });

  it('parseIgnore splits comma/newline, trims, de-dupes', () => {
    expect(parseIgnore('.obsidian, .trash\n.obsidian')).toEqual(['.obsidian', '.trash']);
  });

  it('buildVaultsConfig omits origin when sync off, includes when on', () => {
    const off = buildVaultsConfig(
      s({ vaultName: 'p', syncEnabled: false, mcp: ['local'] }),
      '/root'
    );
    expect(off.vaults.p.origin).toBeUndefined();
    expect(off.vaults.p.path).toBe('/root');
    const on = buildVaultsConfig(
      s({
        vaultName: 'p',
        syncEnabled: true,
        origin: { remote: 'agentage', interval: 5, ignore: [] },
        mcp: ['local'],
      }),
      '/root'
    );
    expect(on.vaults.p.origin?.[0].remote).toBe('agentage');
  });

  it('validateSettings flags sync-on-without-remote', () => {
    expect(
      validateSettings(
        s({ vaultName: 'p', syncEnabled: true, origin: { remote: '', interval: 5, ignore: [] } })
      )
    ).toHaveLength(1);
    expect(
      validateSettings(
        s({
          vaultName: 'p',
          syncEnabled: true,
          origin: { remote: 'agentage', interval: 5, ignore: [] },
        })
      )
    ).toHaveLength(0);
  });
});
