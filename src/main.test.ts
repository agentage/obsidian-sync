import { describe, it, expect, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import type { CouchSync } from './couch/couch-sync';
import type { CouchChannel } from './couch/couch-channel';

// Captured Notice text so a guard-path test can assert the user-facing message (hoisted so the
// vi.mock factory below can close over it).
const { noticeMessages } = vi.hoisted(() => ({ noticeMessages: [] as string[] }));

// Only the Obsidian runtime surface the whole main.ts import graph touches at load time
// (class bases + Platform.isDesktopApp); everything else the plugin uses is injected below.
vi.mock('obsidian', () => ({
  FileSystemAdapter: class FileSystemAdapter {},
  Menu: class Menu {},
  Modal: class Modal {},
  Notice: class Notice {
    constructor(message: string) {
      noticeMessages.push(message);
    }
  },
  Platform: { isDesktopApp: true },
  Plugin: class Plugin {},
  PluginSettingTab: class PluginSettingTab {},
  FuzzySuggestModal: class FuzzySuggestModal {},
  Setting: class Setting {},
  TFile: class TFile {},
  requestUrl: vi.fn(),
  normalizePath: (p: string) => p,
  debounce: (fn: unknown) => fn,
}));

// A CouchSync stand-in with spied delegation methods (the channel only calls these three).
const fakeSync = (): CouchSync =>
  ({
    tick: vi.fn(async () => {}),
    pushFileLive: vi.fn(async (_p: string) => {}),
    removeFile: vi.fn(async (_p: string) => {}),
  }) as unknown as CouchSync;

// onAuthChanged/refreshStatus early-return without a status bar; settingTab is undefined.
type Testable = {
  auth: { isSignedIn: () => boolean };
  couchChannel: CouchChannel;
  onAuthChanged: () => void;
};

const makePlugin = async (): Promise<Testable> => {
  const { default: AgentageMemoryPlugin } = await import('./main');
  // The mocked Plugin base ignores its ctor args; pass stubs to satisfy the Obsidian types.
  const plugin = new AgentageMemoryPlugin({} as unknown as App, {} as unknown as PluginManifest);
  return plugin as unknown as Testable;
};

describe('onAuthChanged tears the couch controller down on an auto sign-out', () => {
  it('clears the live controller when signed out so a later tick no-ops', async () => {
    const plugin = await makePlugin();
    const a = fakeSync();
    plugin.couchChannel.for('A', () => a);
    expect(plugin.couchChannel.active).toBe(true);

    plugin.auth = { isSignedIn: () => false }; // dead-session clear routed here (not disconnect)
    plugin.onAuthChanged();

    expect(plugin.couchChannel.active).toBe(false);
    await plugin.couchChannel.tick();
    await plugin.couchChannel.pushFileLive('x.md');
    expect(a.tick).not.toHaveBeenCalled();
    expect(a.pushFileLive).not.toHaveBeenCalled();
    // A different user on the same memory rebuilds a fresh controller (correct db) instead of reusing the stale one.
    const b = fakeSync();
    expect(plugin.couchChannel.for('A', () => b)).toBe(b);
  });

  it('keeps the live controller while still signed in', async () => {
    const plugin = await makePlugin();
    const a = fakeSync();
    plugin.couchChannel.for('A', () => a);

    plugin.auth = { isSignedIn: () => true };
    plugin.onAuthChanged();

    expect(plugin.couchChannel.active).toBe(true);
    await plugin.couchChannel.tick();
    expect(a.tick).toHaveBeenCalledOnce();
  });
});

describe('syncNow routes couch memories to couch and errors on non-couch memories', () => {
  // A resolution advertising `work` on the couch channel.
  const couchResolution = {
    region: 'default',
    ttl: 3600,
    couchEndpoint: 'https://couch.x',
    couchTokenUrl: 'https://auth.x/account/couch-token',
    couchVaults: [{ vault: 'work', db: 'mem_abc' }],
  };
  // An old-server resolution with no couch channel at all (server flip pending).
  const noCouchResolution = { region: 'default', ttl: 3600 };

  type Harness = {
    auth: { getValidToken: () => Promise<string | null> };
    resolver: { resolve: (t: string) => Promise<unknown> };
    settings: { vault: string };
    couchChannel: { clear: () => void };
    setStatusBar: (s: string, msg?: string) => void;
    couchSyncNow: (ch: unknown, memory: string) => Promise<{ ok: boolean; message: string }>;
    syncNow: () => Promise<{ ok: boolean; message: string }>;
  };

  const makeHarness = async (resolution: unknown): Promise<Harness> => {
    const { default: AgentageMemoryPlugin } = await import('./main');
    const plugin = new AgentageMemoryPlugin(
      {} as unknown as App,
      {} as unknown as PluginManifest
    ) as unknown as Harness;
    plugin.auth = { getValidToken: async () => 'tok' };
    plugin.resolver = { resolve: async () => resolution };
    plugin.settings = { vault: 'work' };
    plugin.couchChannel = { clear: vi.fn() } as unknown as Harness['couchChannel'];
    plugin.setStatusBar = vi.fn();
    return plugin;
  };

  it('engages couch for a memory advertised on the couch channel', async () => {
    noticeMessages.length = 0;
    const plugin = await makeHarness(couchResolution);
    const couchSpy = vi.fn(async () => ({ ok: true, message: 'work: couch synced' }));
    plugin.couchSyncNow = couchSpy;

    const r = await plugin.syncNow();

    expect(couchSpy).toHaveBeenCalledWith(expect.anything(), 'work');
    expect(r).toEqual({ ok: true, message: 'work: couch synced' });
  });

  it('surfaces a clear error (never git) for a memory not yet on the couch channel', async () => {
    noticeMessages.length = 0;
    const plugin = await makeHarness(noCouchResolution);
    const couchSpy = vi.fn(async () => ({ ok: true, message: 'engaged' }));
    plugin.couchSyncNow = couchSpy;

    const r = await plugin.syncNow();

    expect(couchSpy).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not on the new sync channel yet');
    expect(noticeMessages.at(-1)).toContain('not on the new sync channel yet');
  });
});
