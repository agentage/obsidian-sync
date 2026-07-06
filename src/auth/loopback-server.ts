// RFC 8252 loopback redirect for desktop OAuth. A one-shot localhost listener captures the
// auth-code callback with NO OS protocol handler involved - snap/flatpak Obsidian silently
// drop `obsidian://` callbacks (each cold-starts a new instance, losing the PKCE state), so
// loopback is the reliable desktop path. node:http is imported lazily and only ever started
// on desktop (main guards on Platform.isDesktopApp), keeping the bundle mobile-safe. Binds
// 127.0.0.1 ONLY (never 0.0.0.0) on an OS-assigned ephemeral port; the caller does a fresh
// DCR with the exact bound redirect, so the AS sees a redirect_uri that matches precisely.
import type * as Http from 'node:http';
import type { LoopbackHandle } from './auth-flow';

const TIMEOUT_MS = 5 * 60_000; // abandon the listener if the user never finishes in the browser
const CALLBACK_PATH = '/callback';

const page = (ok: boolean, detail: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Agentage Sync</title></head>` +
  `<body style="font:15px/1.6 system-ui,sans-serif;max-width:30rem;margin:4rem auto;padding:0 1rem;text-align:center;color:#222">` +
  `<h2 style="margin:.2rem 0">${ok ? '✅ Signed in to Agentage' : '⚠️ Sign-in problem'}</h2>` +
  `<p>${detail}</p><p style="color:#888">You can close this tab and return to Obsidian.</p></body></html>`;

// Start the listener and return the redirect URL + a promise that resolves with the OAuth
// query params once the browser hits it. `close()` is idempotent and stops the server.
export async function startLoopbackServer(): Promise<LoopbackHandle> {
  const http = await import('node:http');

  let resolveParams!: (p: Record<string, string>) => void;
  let rejectParams!: (e: Error) => void;
  const waitForCode = new Promise<Record<string, string>>((resolve, reject) => {
    resolveParams = resolve;
    rejectParams = reject;
  });

  const server: Http.Server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end(); // ignore favicon and stray probes
      return;
    }
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => (params[key] = value));
    const ok = !params.error && !!params.code;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(ok, ok ? 'Authorization received.' : (params.error ?? 'No authorization code.')));
    resolveParams(params);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (!port) {
    server.close();
    throw new Error('could not bind a loopback port for sign-in');
  }

  // `window` in the Obsidian renderer; the global fallback is only ever taken under node
  // (vitest), where `window` is absent - a transient OAuth timer needs no popout scoping.
  type TimerHost = {
    setTimeout: (cb: () => void, ms: number) => number;
    clearTimeout: (id: number) => void;
  };
  const timers: TimerHost =
    typeof window !== 'undefined'
      ? (window as unknown as TimerHost)
      : // eslint-disable-next-line obsidianmd/no-global-this -- node test fallback; renderer uses window
        (globalThis as unknown as TimerHost);
  const timer = timers.setTimeout(() => {
    server.close();
    rejectParams(new Error('sign-in timed out'));
  }, TIMEOUT_MS);

  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    waitForCode,
    close: () => {
      timers.clearTimeout(timer);
      server.close();
    },
  };
}
