import { _electron, type ElectronApplication } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * Common Obsidian install paths per platform. Override with the
 * `OBSIDIAN_BIN` env var when running tests against a non-default install
 * (e.g. AppImage if Snap confinement blocks Playwright).
 */
const CANDIDATE_PATHS = [
  // Linux (Snap)
  '/snap/obsidian/current/obsidian',
  // Linux (deb / system)
  '/opt/Obsidian/obsidian',
  '/opt/obsidian/obsidian',
  '/usr/bin/obsidian',
  // macOS
  '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
  // Windows (run via WSL is rare; keeping for completeness)
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

export async function launchObsidian(): Promise<ElectronApplication> {
  const app = await _electron.launch({
    executablePath: findObsidianBinary(),
    // Electron-in-CI flags: --no-sandbox for Snap/CI sandboxes;
    // --disable-gpu / --disable-software-rasterizer to skip GPU init that
    // crashes inside Xvfb; --disable-dev-shm-usage because GitHub runners'
    // /dev/shm is too small for Chromium's default.
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-dev-shm-usage',
    ],
  });
  // Surface Obsidian's own stdout/stderr in test logs so CI failures aren't
  // a black box. Playwright's `process()` returns the underlying child.
  const proc = app.process();
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[obsidian] ${d}`));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[obsidian!] ${d}`));
  return app;
}
