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
