import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

const CANDIDATE_PATHS = [
  '/snap/obsidian/current/obsidian',
  '/opt/Obsidian/obsidian',
  '/opt/obsidian/obsidian',
  '/usr/bin/obsidian',
  '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
  'C:\\Program Files\\Obsidian\\Obsidian.exe',
];

export function findObsidianBinary(): string {
  const fromEnv = process.env.OBSIDIAN_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`OBSIDIAN_BIN points to a path that doesn't exist: ${fromEnv}`);
    }
    return fromEnv;
  }
  for (const p of CANDIDATE_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not locate Obsidian. Set OBSIDIAN_BIN=<path-to-obsidian-binary>. ` +
      `Searched:\n  ${CANDIDATE_PATHS.join('\n  ')}`
  );
}

export interface LaunchOptions {
  vault?: string;
  timeoutMs?: number;
  /** Port for chrome devtools. 0 = auto-allocate. */
  cdpPort?: number;
}

export interface ObsidianHandle {
  browser: Browser;
  context: BrowserContext;
  proc: ChildProcess;
  /** First non-empty page Obsidian opens (vault main window). */
  firstWindow(timeoutMs?: number): Promise<Page>;
  close(): Promise<void>;
}

// `_electron.launch` waits for the node inspector Obsidian never opens and
// hangs. Spawn directly, parse the DevTools URL, attach via `connectOverCDP`.
export async function launchObsidian(opts: LaunchOptions = {}): Promise<ObsidianHandle> {
  const vault = opts.vault ?? process.env.OBSIDIAN_VAULT;
  const cdpPort = opts.cdpPort ?? 0;
  const args: string[] = [];
  if (vault) args.push(vault);
  args.push(
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--use-gl=swiftshader',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*'
  );

  const proc = spawn(findObsidianBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d: Buffer) => process.stdout.write(`[obsidian] ${d}`));

  const wsUrl = await new Promise<string>((resolve, reject) => {
    const onExit = (code: number | null) => reject(new Error(`Obsidian exited (code=${code}) before DevTools came up`));
    proc.once('exit', onExit);

    const onTimeout = setTimeout(() => {
      proc.off('exit', onExit);
      reject(new Error(`Timed out waiting for Obsidian DevTools URL (${opts.timeoutMs ?? 60_000}ms)`));
    }, opts.timeoutMs ?? 60_000);

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(`[obsidian!] ${text}`);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (m) {
        clearTimeout(onTimeout);
        proc.off('exit', onExit);
        resolve(m[1]);
      }
    });
  });

  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());

  const firstWindow = async (timeoutMs = 60_000): Promise<Page> => {
    const existing = context.pages().find((p) => p.url() !== 'about:blank' && p.url() !== '');
    if (existing) return existing;
    return new Promise<Page>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`No Obsidian window in ${timeoutMs}ms`)),
        timeoutMs
      );
      context.once('page', (page) => {
        clearTimeout(t);
        resolve(page);
      });
    });
  };

  const close = async () => {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    if (!proc.killed) proc.kill('SIGTERM');
  };

  return { browser, context, proc, firstWindow, close };
}
