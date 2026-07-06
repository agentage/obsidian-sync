import type { CouchSync } from './couch-sync';

// Holds the single live couch controller + which memory it replicates. A memory switch or a
// git-route sync tears the old controller down (`clear`) so its live vault handlers + the 2s
// tick no-op instead of pulling the previous memory's docs into (or pushing this vault's edits
// out to) the wrong db. The Obsidian side supplies the `build` factory and rebuilds on demand.
export class CouchChannel {
  private sync?: CouchSync;
  private memory?: string;

  /** The controller for `memory`, (re)built via `build` when the memory changed or none is live. */
  for(memory: string, build: () => CouchSync): CouchSync {
    if (this.memory !== memory || !this.sync) {
      this.sync = build();
      this.memory = memory;
    }
    return this.sync;
  }

  /** Tear the controller down so later handlers + ticks no-op (memory switch / sign-out). */
  clear(): void {
    this.sync = undefined;
    this.memory = undefined;
  }

  /** True while a controller is live; a switch back to its memory rebuilds via `for`. */
  get active(): boolean {
    return !!this.sync;
  }

  tick(): Promise<void> {
    return this.sync?.tick() ?? Promise.resolve();
  }
  pushFileLive(path: string): Promise<void> {
    return this.sync?.pushFileLive(path) ?? Promise.resolve();
  }
  removeFile(path: string): Promise<void> {
    return this.sync?.removeFile(path) ?? Promise.resolve();
  }
}
