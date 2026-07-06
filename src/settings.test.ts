import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  PROD_SITE_FQDN,
  buildVaultsConfig,
  normalizeRemote,
  normalizeVaultName,
  parseIgnore,
  resolveSiteFqdn,
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

  it('resolveSiteFqdn: setting > env > prod', () => {
    expect(resolveSiteFqdn('dev.agentage.io', 'env.agentage.io')).toBe('dev.agentage.io');
    expect(resolveSiteFqdn('', 'env.agentage.io')).toBe('env.agentage.io');
    expect(resolveSiteFqdn('', undefined)).toBe(PROD_SITE_FQDN);
    expect(resolveSiteFqdn('', '')).toBe(PROD_SITE_FQDN);
  });

  it('resolveSiteFqdn tolerates whitespace, a pasted scheme, and trailing slashes', () => {
    expect(resolveSiteFqdn('  dev.agentage.io  ', undefined)).toBe('dev.agentage.io');
    expect(resolveSiteFqdn('https://dev.agentage.io/', undefined)).toBe('dev.agentage.io');
    expect(resolveSiteFqdn('   ', ' env.agentage.io/ ')).toBe('env.agentage.io');
    // Whitespace-only everywhere still falls back to prod.
    expect(resolveSiteFqdn(' ', ' ')).toBe(PROD_SITE_FQDN);
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
