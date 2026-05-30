import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeServerUrl } from './settings';

describe('settings', () => {
  it('defaults to the single agentage sync host', () => {
    expect(DEFAULT_SETTINGS.serverUrl).toBe('https://sync.agentage.io');
    // Auth shares the same host (single-host model): one host for sign-in + sync.
    expect(new URL(DEFAULT_SETTINGS.authBase).origin).toBe(DEFAULT_SETTINGS.serverUrl);
  });

  describe('normalizeServerUrl', () => {
    it('trims surrounding whitespace', () => {
      expect(normalizeServerUrl('  https://example.com  ')).toBe('https://example.com');
    });

    it('strips trailing slashes', () => {
      expect(normalizeServerUrl('https://example.com///')).toBe('https://example.com');
    });

    it('leaves a clean url unchanged', () => {
      expect(normalizeServerUrl('https://example.com/path')).toBe('https://example.com/path');
    });
  });
});
