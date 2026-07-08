import { vi } from 'vitest';
import type { App, PluginManifest, Platform as PlatformType } from 'obsidian';
import * as obsidian from 'obsidian';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeVault } from './fake-vault';
import { fakeSecrets, type FakeSecrets } from './fake-secrets';
import { FakeCouch } from './fake-couch';
import { FakeAuthServer, type FakeMemory } from './fake-auth-server';
import { Router } from './router';
import { requestUrlMock, makeFakeApp } from './obsidian';

// bootPlugin(): assemble the REAL AgentageMemoryPlugin against the fully-mocked host + fakes and
// run its actual onload(). The ONLY injection seams are requestUrl (mocked) + the property-shaped
// fake app - main.ts has no DI constructor, so this file is the single point that must change if
// the plugin's Obsidian wiring changes. Returns handles + a teardown.

export interface BootOptions {
  fqdn?: string;
  files?: Record<string, string>;
  memories?: FakeMemory[];
  memoryName?: string; // the couch-channel memory the resolution advertises
  couchDb?: string;
  desktop?: boolean; // Platform.isDesktopApp; false -> obsidian:// deep-link sign-in path
}

export interface Handles {
  plugin: import('../../src/main').default;
  couch: FakeCouch;
  auth: FakeAuthServer;
  vault: FakeVault;
  router: Router;
  secrets: FakeSecrets;
  configDir: string;
  /** URLs passed to window.open (the authorize redirect). */
  openedUrls: string[];
  teardown: () => Promise<void>;
}

type WindowStub = {
  open: (url: string) => void;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
};

export async function bootPlugin(opts: BootOptions = {}): Promise<Handles> {
  const fqdn = opts.fqdn ?? 'test.local';
  const memoryName = opts.memoryName ?? 'work';
  const couchDb = opts.couchDb ?? 'mem_work';

  const vault = new FakeVault(opts.files ?? {});
  const secrets = fakeSecrets();
  const couch = new FakeCouch(couchDb);
  const auth = new FakeAuthServer({ memories: opts.memories ?? [], couchDb });
  const router = new Router({ fqdn, auth, couch, memoryName });

  requestUrlMock.mockImplementation(router.requestUrl);

  // A throwaway config dir so auth.json + vaults.json writes never touch ~/.agentage.
  const configDir = await fs.mkdtemp(join(tmpdir(), 'ams-e2e-'));
  const prevConfigDir = process.env.AGENTAGE_CONFIG_DIR;
  const prevSiteFqdn = process.env.AGENTAGE_SITE_FQDN;
  process.env.AGENTAGE_CONFIG_DIR = configDir;
  process.env.AGENTAGE_SITE_FQDN = fqdn;

  // Desktop drives loopback (a real node:http listener); the deep-link path is simpler + fully
  // in-memory, so the smoke forces isDesktopApp=false and drives handleCallback via the router.
  const desktop = opts.desktop ?? false;
  (obsidian.Platform as unknown as typeof PlatformType & { isDesktopApp: boolean }).isDesktopApp =
    desktop;

  const openedUrls: string[] = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  const windowStub: WindowStub = {
    open: (url: string) => void openedUrls.push(url),
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.add(id);
      return id as unknown as number;
    },
    clearInterval: (id) => clearInterval(id as unknown as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
  };
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = windowStub;

  const { default: AgentageMemoryPlugin } = await import('../../src/main');
  const app = makeFakeApp(vault, secrets) as unknown as App;
  const manifest = { id: 'agentage-memory', version: '0.0.0' } as unknown as PluginManifest;
  const plugin = new AgentageMemoryPlugin(app, manifest);
  await plugin.onload();

  const teardown = async (): Promise<void> => {
    for (const id of timers) clearInterval(id);
    (globalThis as { window?: unknown }).window = prevWindow;
    if (prevConfigDir === undefined) delete process.env.AGENTAGE_CONFIG_DIR;
    else process.env.AGENTAGE_CONFIG_DIR = prevConfigDir;
    if (prevSiteFqdn === undefined) delete process.env.AGENTAGE_SITE_FQDN;
    else process.env.AGENTAGE_SITE_FQDN = prevSiteFqdn;
    requestUrlMock.mockReset();
    await fs.rm(configDir, { recursive: true, force: true });
  };

  return { plugin, couch, auth, vault, router, secrets, configDir, openedUrls, teardown };
}

// Drive a full obsidian:// sign-in against the fakes: startSignIn -> capture the authorize URL ->
// mint a code at the fake AS -> feed the callback back through the plugin's protocol handler.
export async function signIn(h: Handles): Promise<void> {
  type SignInPlugin = {
    openSignIn: () => void;
    auth: { handleCallback: (p: Record<string, string>) => Promise<void> };
  };
  const p = h.plugin as unknown as SignInPlugin;
  const before = h.openedUrls.length;
  p.openSignIn();
  await vi.waitFor(() => {
    if (h.openedUrls.length <= before) throw new Error('no authorize URL yet');
  });
  const authorizeUrl = new URL(h.openedUrls[h.openedUrls.length - 1]);
  const clientId = authorizeUrl.searchParams.get('client_id') ?? '';
  const state = authorizeUrl.searchParams.get('state') ?? '';
  const codeChallenge = authorizeUrl.searchParams.get('code_challenge') ?? '';
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri') ?? '';
  const { code } = h.auth.authorize({ clientId, codeChallenge, state, redirectUri });
  await p.auth.handleCallback({ code, state });
}
