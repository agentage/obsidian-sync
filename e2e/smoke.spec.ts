import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { findObsidianBinary } from './helpers/launch';

/**
 * Smoke test — proves Obsidian launches with our test vault, stays alive,
 * and creates a renderer window.
 *
 * We deliberately don't use Playwright's `_electron.launch` here: against
 * Obsidian 1.12.x it injects `--inspect=0 --remote-debugging-port=0`, prints
 * the DevTools URL, then hangs forever in `firstWindow()` even though the
 * window does paint (confirmed by the workflow's pre-test diagnostic).
 * `child_process.spawn` + an `xdotool` window check sidesteps that
 * incompatibility while still proving the binary actually renders under
 * our xvfb / herbstluftwm CI stack.
 */
test.setTimeout(60_000);

test('Obsidian launches, stays alive, and renders an Obsidian window', async () => {
  const obsidian = findObsidianBinary();
  const vault = process.env.OBSIDIAN_VAULT ?? '/tmp/obsidian-test-vault';

  const proc = spawn(
    obsidian,
    [
      vault,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--use-gl=swiftshader',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );

  try {
    // Give Obsidian ~15 s to load the vault and open the main window.
    await new Promise((r) => setTimeout(r, 15_000));

    expect(proc.exitCode, 'Obsidian process exited during warmup').toBeNull();

    const windows = execFileSync('xdotool', ['search', '--name', 'Obsidian'], {
      env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    expect(windows.length, 'no window with title matching "Obsidian"').toBeGreaterThan(0);
  } finally {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 2_000));
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  }
});
