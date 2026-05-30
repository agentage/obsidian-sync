/**
 * Path for the sidecar note that preserves a losing revision when the same
 * note was edited in two places at once (locked rule #3: keep both, never
 * silently drop one). Derived deterministically from the losing revision so
 * re-resolving the same conflict maps to the same file — idempotent, and two
 * devices racing to resolve converge on one sidecar instead of duplicating.
 *
 *   notes/foo.md + rev "2-9abc…" -> notes/foo.conflict-29abc….md
 */
export function conflictSidecarPath(basePath: string, losingRev: string): string {
  const tag = shortRev(losingRev);
  const slash = basePath.lastIndexOf('/');
  const dot = basePath.lastIndexOf('.');
  if (dot > slash) {
    return `${basePath.slice(0, dot)}.conflict-${tag}${basePath.slice(dot)}`;
  }
  return `${basePath}.conflict-${tag}`;
}

/** The hash portion of a `<gen>-<hash>` PouchDB revision, trimmed for a path. */
function shortRev(rev: string): string {
  const dash = rev.indexOf('-');
  const hash = dash >= 0 ? rev.slice(dash + 1) : rev;
  return hash.slice(0, 8);
}
