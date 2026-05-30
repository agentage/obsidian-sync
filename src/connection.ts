import { normalizeServerUrl } from './settings';

export interface PingResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface FetchLike {
  (url: string): Promise<{ status: number }>;
}

/**
 * Ping a CouchDB server's `/_up` endpoint to confirm reachability.
 * Pure: takes the fetch impl as a parameter so it stays unit-testable
 * without the Obsidian runtime.
 */
export async function pingServer(url: string, fetchImpl: FetchLike): Promise<PingResult> {
  try {
    const target = url.replace(/\/+$/, '') + '/_up';
    const res = await fetchImpl(target);
    return res.status >= 200 && res.status < 300
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * True when the server URL is still the default cloud host. That host is the
 * API/OAuth host, not a CouchDB — pinging its `/_up` is meaningless (404s), so a
 * user who hasn't pointed the plugin at a real CouchDB should be told to sign in,
 * not shown a raw HTTP failure for a correctly-installed plugin.
 */
export function isUnconfiguredDefault(serverUrl: string, defaultUrl: string): boolean {
  return normalizeServerUrl(serverUrl) === normalizeServerUrl(defaultUrl);
}

/**
 * Whether the plugin may open a replication connection. Obsidian's Developer
 * Policy forbids unsolicited network calls, so a fresh / signed-out install must
 * stay silent until the user acts. Two conditions must both hold:
 *  - a **real CouchDB target**: the host is no longer the default API/OAuth host
 *    (replicating to the default host is meaningless and would just error), and
 *  - **auth is present**: the user supplied credentials (local-dev / e2e path)
 *    or is signed in (the bootstrap path, once it sets a real host).
 * A fresh install (default host) never replicates, even after sign-in — sync
 * starts only when there is a real host to sync to. Pure: unit-tested without
 * the Obsidian runtime.
 */
export function shouldStartReplication(params: {
  serverUrl: string;
  defaultUrl: string;
  hasCreds: boolean;
  isSignedIn: boolean;
}): boolean {
  const hasRealTarget = !isUnconfiguredDefault(params.serverUrl, params.defaultUrl);
  return hasRealTarget && (params.hasCreds || params.isSignedIn);
}
