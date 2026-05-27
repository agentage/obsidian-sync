/**
 * Extract useful fields from a PouchDB / fetch error so logs aren't just `n`.
 * Returns a plain object DevTools can pretty-print, or a string when the
 * input has no useful shape (null, primitive).
 */
export function describeErr(err: unknown): Record<string, unknown> | string {
  if (err == null) return 'unknown';
  if (typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown>;
  return {
    name: e.name,
    message: e.message,
    status: e.status,
    reason: e.reason,
    error: e.error,
    docId: e.docId,
  };
}
