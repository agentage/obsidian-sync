import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${root}/${rel}`, 'utf8'));

const manifest = readJson('manifest.json');
const versions = readJson('versions.json');
const pkg = readJson('package.json');

const description = manifest.description as string;
const version = manifest.version as string;
const minAppVersion = manifest.minAppVersion as string;

describe('manifest store-compliance', () => {
  it('description is at most 250 characters', () => {
    expect(description.length).toBeLessThanOrEqual(250);
  });

  it('description starts with an action verb', () => {
    const firstWord = description.split(' ')[0];
    expect(['Sync', 'Connect', 'Store', 'Mirror']).toContain(firstWord);
  });

  it('description ends with a period', () => {
    expect(description.endsWith('.')).toBe(true);
  });

  it('description contains no emoji', () => {
    expect(description).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('description matches validateManifest charset (no parens/colons/etc.)', () => {
    expect(description).toMatch(/^[A-Za-z0-9\s.,!?'"-]+$/);
  });

  it('description contains no forbidden words (obsidian/plugin)', () => {
    expect(description).not.toMatch(/\b(obsidian|plugin)\b/i);
  });

  it('display name contains no forbidden words (obsidian/plugin)', () => {
    expect(manifest.name as string).not.toMatch(/\b(obsidian|plugin)\b/i);
  });

  it('id is the canonical plugin id', () => {
    expect(manifest.id).toBe('agentage-memory');
  });

  it('display name is Basic-Latin only', () => {
    const name = manifest.name as string;
    expect([...name].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });

  it('declares a minAppVersion', () => {
    expect(minAppVersion).toBeTruthy();
  });

  it('versions.json maps the current version to its minAppVersion', () => {
    expect(versions[version]).toBe(minAppVersion);
  });
});

describe('package metadata consistency', () => {
  it('license is not UNLICENSED (a LICENSE file grants run-rights)', () => {
    expect(pkg.license).not.toBe('UNLICENSED');
  });

  it('ships a LICENSE file', () => {
    expect(existsSync(`${root}/LICENSE`)).toBe(true);
  });
});
