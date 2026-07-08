import type { CouchMemoryState } from '../settings';

// Per-(host, memory) sync state, persisted through the plugin's saveData/loadData (the
// same channel settings use). Holds the resumable pull cursor (so a reload does not re-pull
// from seq 0), the path -> content-rev map (so an unchanged push skips the network), the
// pending-push set (paths whose live push failed), and the pending-delete set (paths whose
// live DELETE failed) - both retried on the next tick. Every mutation persists so the state
// survives a reload; a no-op mutation skips the write.

export type LoadCouchState = () => CouchMemoryState | undefined;
export type SaveCouchState = (state: CouchMemoryState) => Promise<void>;

export class CouchState {
  private cursor: string;
  private readonly revs: Map<string, string>;
  private readonly pending: Set<string>;
  private readonly pendingDeletes: Set<string>;

  constructor(
    load: LoadCouchState,
    private readonly save: SaveCouchState
  ) {
    const s = load() ?? {};
    this.cursor = s.cursor ?? '0';
    this.revs = new Map(Object.entries(s.revs ?? {}));
    this.pending = new Set(s.pending ?? []);
    this.pendingDeletes = new Set(s.pendingDeletes ?? []);
  }

  getCursor(): string {
    return this.cursor;
  }
  async setCursor(seq: string): Promise<void> {
    if (seq === this.cursor) return;
    this.cursor = seq;
    await this.persist();
  }

  revFor(path: string): string | undefined {
    return this.revs.get(path);
  }
  // Paths we hold a content-rev for - "files we have synced". The disambiguator for a local
  // deletion (known path absent from the vault) vs new remote content (unknown path).
  knownPaths(): string[] {
    return [...this.revs.keys()];
  }
  async setRev(path: string, rev: string): Promise<void> {
    if (this.revs.get(path) === rev) return;
    this.revs.set(path, rev);
    await this.persist();
  }
  async dropRev(path: string): Promise<void> {
    if (this.revs.delete(path)) await this.persist();
  }

  pendingPaths(): string[] {
    return [...this.pending];
  }
  async enqueue(path: string): Promise<void> {
    if (this.pending.has(path)) return;
    this.pending.add(path);
    await this.persist();
  }
  async dequeue(path: string): Promise<void> {
    if (this.pending.delete(path)) await this.persist();
  }

  pendingDeletePaths(): string[] {
    return [...this.pendingDeletes];
  }
  async enqueueDelete(path: string): Promise<void> {
    if (this.pendingDeletes.has(path)) return;
    this.pendingDeletes.add(path);
    await this.persist();
  }
  async dequeueDelete(path: string): Promise<void> {
    if (this.pendingDeletes.delete(path)) await this.persist();
  }

  private async persist(): Promise<void> {
    await this.save({
      cursor: this.cursor,
      revs: Object.fromEntries(this.revs),
      pending: [...this.pending],
      pendingDeletes: [...this.pendingDeletes],
    });
  }
}
