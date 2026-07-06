import type { CouchMemoryState } from '../settings';

// Per-(host, memory) sync state, persisted through the plugin's saveData/loadData (the
// same channel settings use). Holds the resumable pull cursor (so a reload does not re-pull
// from seq 0), the path -> content-rev map (so an unchanged push skips the network), and the
// pending-push set (paths whose live push failed, retried on the next tick). Every mutation
// persists so the state survives a reload; a no-op mutation skips the write.

export type LoadCouchState = () => CouchMemoryState | undefined;
export type SaveCouchState = (state: CouchMemoryState) => Promise<void>;

export class CouchState {
  private cursor: string;
  private readonly revs: Map<string, string>;
  private readonly pending: Set<string>;

  constructor(
    load: LoadCouchState,
    private readonly save: SaveCouchState
  ) {
    const s = load() ?? {};
    this.cursor = s.cursor ?? '0';
    this.revs = new Map(Object.entries(s.revs ?? {}));
    this.pending = new Set(s.pending ?? []);
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

  private async persist(): Promise<void> {
    await this.save({
      cursor: this.cursor,
      revs: Object.fromEntries(this.revs),
      pending: [...this.pending],
    });
  }
}
