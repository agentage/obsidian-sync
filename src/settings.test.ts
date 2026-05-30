import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeServerUrl } from './settings';

describe('settings', () => {
  it('defaults to the agentage cloud endpoint', () => {
    expect(DEFAULT_SETTINGS.serverUrl).toBe('https://memory.agentage.io');
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
