import { TFile } from 'obsidian';

// Lifted from src/couch/couch-sync.test.ts and extended with a real event emitter so the
// assembled plugin's live handlers (vault.on 'create'/'modify'/'delete'/'rename') can be
// driven, and with getName/adapter so main.ts's vault-name + root-path helpers work.

export type VaultEvent = 'create' | 'modify' | 'delete' | 'rename';
type Listener = (file: TFile, oldPath?: string) => void;

const mkFile = (path: string): TFile =>
  Object.assign(new TFile(), { path, extension: path.split('.').pop() ?? '' }) as unknown as TFile;

export class FakeVault {
  private files = new Map<string, { file: TFile; content: string }>();
  private listeners = new Map<VaultEvent, Set<Listener>>();
  modifyCalls = 0;
  createCalls = 0;
  deleteCalls = 0;

  constructor(
    init: Record<string, string> = {},
    private name = 'test-vault'
  ) {
    for (const [p, c] of Object.entries(init)) this.files.set(p, { file: mkFile(p), content: c });
  }

  getName(): string {
    return this.name;
  }

  // main.ts reads adapter.getBasePath() only when the adapter is a FileSystemAdapter; ours is
  // not, so it falls back to getName() - a plain object is enough to satisfy the property read.
  readonly adapter = {} as unknown;

  getAbstractFileByPath(p: string): TFile | null {
    return this.files.get(p)?.file ?? null;
  }
  async read(f: TFile): Promise<string> {
    return this.files.get(f.path)?.content ?? '';
  }
  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].map((v) => v.file).filter((f) => f.extension === 'md');
  }
  async modify(f: TFile, data: string): Promise<void> {
    this.modifyCalls++;
    this.files.set(f.path, { file: f, content: data });
  }
  async create(p: string, data: string): Promise<TFile> {
    this.createCalls++;
    const file = mkFile(p);
    this.files.set(p, { file, content: data });
    return file;
  }
  async createFolder(_p: string): Promise<void> {}
  async delete(f: TFile): Promise<void> {
    this.deleteCalls++;
    this.files.delete(f.path);
  }

  content(p: string): string | undefined {
    return this.files.get(p)?.content;
  }
  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  // --- event emitter (Obsidian's EventRef surface is unused by main.ts's registerEvent) ---
  on(event: VaultEvent, cb: Listener): { event: VaultEvent } {
    (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(cb);
    return { event };
  }

  /** Drive a vault event AND apply it to the in-memory store, mirroring a real user edit. */
  trigger(event: VaultEvent, path: string, content?: string, oldPath?: string): void {
    if (event === 'create' && content !== undefined)
      this.files.set(path, { file: mkFile(path), content });
    if (event === 'modify' && content !== undefined) {
      const cur = this.files.get(path);
      this.files.set(path, { file: cur?.file ?? mkFile(path), content });
    }
    if (event === 'delete') this.files.delete(path);
    if (event === 'rename' && oldPath) {
      const prev = this.files.get(oldPath);
      this.files.delete(oldPath);
      this.files.set(path, { file: mkFile(path), content: prev?.content ?? content ?? '' });
    }
    const file = mkFile(path);
    for (const cb of this.listeners.get(event) ?? []) cb(file, oldPath);
  }
}
