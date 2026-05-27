import { _electron, type ElectronApplication } from '@playwright/test';
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
  /** Vault path to pass as positional arg. Falls back to `OBSIDIAN_VAULT` env. */
  vault?: string;
  /** Cap how long `_electron.launch` waits before failing. */
  timeoutMs?: number;
}

export async function launchObsidian(opts: LaunchOptions = {}): Promise<ElectronApplication> {
  const vault = opts.vault ?? process.env.OBSIDIAN_VAULT;
  const args: string[] = [];
  if (vault) args.push(vault);
  // Xvfb has no dri3 — the GPU process crashes and takes the renderer with
  // it, so Playwright's `firstWindow()` never resolves. Force the software
  // path with --disable-gpu + --disable-software-rasterizer + --use-gl=swiftshader.
  args.push(
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--use-gl=swiftshader'
  );

  const app = await _electron.launch({
    executablePath: findObsidianBinary(),
    args,
    timeout: opts.timeoutMs ?? 90_000,
  });

  const proc = app.process();
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[obsidian] ${d}`));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[obsidian!] ${d}`));
  return app;
}
