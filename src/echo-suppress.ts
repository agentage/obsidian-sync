/**
 * One-shot suppression of the vault event our own sync just triggered.
 *
 * When we write a file *because of an inbound replication*, that write fires
 * `vault.on('modify' | 'create')`. Without suppression, the handler upserts
 * the doc again — which replicates outward — which echoes back as another
 * inbound change. The TTL acts as a GC so a stale mark never leaks if the
 * expected vault event somehow doesn't fire.
 */

export interface EchoSuppress {
  /** Record that we just wrote `path` from sync; the next vault event is ours. */
  mark(path: string): void;
  /** True iff a fresh-enough mark exists for `path` (also removes it). */
  consume(path: string): boolean;
}

export function createEchoSuppress(ttlMs = 5_000): EchoSuppress {
  const entries = new Map<string, number>();
  return {
    mark(path) {
      entries.set(path, Date.now());
    },
    consume(path) {
      const ts = entries.get(path);
      if (ts == null) return false;
      entries.delete(path);
      return Date.now() - ts < ttlMs;
    },
  };
}
