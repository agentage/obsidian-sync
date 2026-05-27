import { requestUrl } from 'obsidian';
import type { PouchFetch, PushCreds } from './pouch';

function headersToObject(h: HeadersInit | undefined | null): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/**
 * Wrap Obsidian's `requestUrl` to look like the browser `fetch` API and inject
 * Basic auth + a JSON `Content-Type` on every request. Auth has to live here
 * (rather than in PouchDB's `auth` constructor option) because that option
 * does not propagate to the live replication `_changes` feed in PouchDB 7+.
 * `requestUrl` runs in the Electron main process and bypasses CORS for us.
 */
export function obsidianFetchForPouch(creds: PushCreds): PouchFetch {
  const authHeader = 'Basic ' + btoa(`${creds.username}:${creds.password}`);
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = (init?.body as string) ?? undefined;
    const headers: Record<string, string> = {
      ...headersToObject(init?.headers),
      Authorization: authHeader,
    };
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await requestUrl({ url, method, headers, body, throw: false });
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
}
