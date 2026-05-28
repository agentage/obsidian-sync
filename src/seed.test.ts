import { describe, expect, it } from 'vitest';
import { notesToSeed, type VaultNote } from './seed';
import type { MemoryDoc } from './pouch';

function replica(...docs: MemoryDoc[]): Map<string, MemoryDoc> {
  return new Map(docs.map((d) => [d._id, d]));
}

const note = (path: string, content: string, mtime = 1000): VaultNote => ({ path, content, mtime });

describe('notesToSeed', () => {
  it('seeds every note when the replica is empty', () => {
    const notes = [note('a.md', 'A'), note('b.md', 'B')];
    expect(notesToSeed(notes, replica())).toEqual(notes);
  });

  it('skips a note already present with identical content', () => {
    const docs = replica({ _id: 'a.md', content: 'A', mtime: 1000 });
    expect(notesToSeed([note('a.md', 'A', 1000)], docs)).toEqual([]);
  });

  it('seeds a note edited while the plugin was off (newer mtime, changed content)', () => {
    const docs = replica({ _id: 'a.md', content: 'old', mtime: 1000 });
    const newer = note('a.md', 'new', 2000);
    expect(notesToSeed([newer], docs)).toEqual([newer]);
  });

  it('does not seed when content differs but the replica copy is newer', () => {
    const docs = replica({ _id: 'a.md', content: 'cloud', mtime: 3000 });
    expect(notesToSeed([note('a.md', 'stale local', 1000)], docs)).toEqual([]);
  });

  it('treats a replica doc with no mtime as oldest', () => {
    const docs = replica({ _id: 'a.md', content: 'x' });
    const local = note('a.md', 'y', 1);
    expect(notesToSeed([local], docs)).toEqual([local]);
  });

  it('seeds only the missing/newer subset of a mixed vault', () => {
    const docs = replica(
      { _id: 'same.md', content: 'S', mtime: 1000 },
      { _id: 'older.md', content: 'cloud', mtime: 5000 }
    );
    const notes = [
      note('same.md', 'S', 1000), // skip: identical
      note('older.md', 'local', 1000), // skip: replica newer
      note('missing.md', 'M', 1000), // seed: absent
    ];
    expect(notesToSeed(notes, docs)).toEqual([note('missing.md', 'M', 1000)]);
  });

  it('returns nothing for an empty vault', () => {
    expect(notesToSeed([], replica({ _id: 'a.md', content: 'A' }))).toEqual([]);
  });
});
