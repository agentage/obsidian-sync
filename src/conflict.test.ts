import { describe, expect, it } from 'vitest';
import { conflictSidecarPath } from './conflict';

describe('conflictSidecarPath', () => {
  it('inserts the rev tag before the .md extension', () => {
    expect(conflictSidecarPath('notes/foo.md', '2-9abcdef0ghij')).toBe(
      'notes/foo.conflict-9abcdef0.md'
    );
  });

  it('handles a note at the vault root', () => {
    expect(conflictSidecarPath('foo.md', '3-deadbeefcafe')).toBe('foo.conflict-deadbeef.md');
  });

  it('does not treat a dot in a parent folder as the extension', () => {
    expect(conflictSidecarPath('my.notes/foo', '1-abcdef12')).toBe(
      'my.notes/foo.conflict-abcdef12'
    );
  });

  it('appends the tag when the path has no extension', () => {
    expect(conflictSidecarPath('README', '1-0123456789')).toBe('README.conflict-01234567');
  });

  it('is deterministic — same rev maps to the same sidecar', () => {
    const a = conflictSidecarPath('a.md', '5-feedface');
    const b = conflictSidecarPath('a.md', '5-feedface');
    expect(a).toBe(b);
  });

  it('distinguishes different losing revs', () => {
    expect(conflictSidecarPath('a.md', '2-aaaaaaaa')).not.toBe(
      conflictSidecarPath('a.md', '2-bbbbbbbb')
    );
  });

  it('tolerates a rev with no generation prefix', () => {
    expect(conflictSidecarPath('a.md', 'abcdef1234')).toBe('a.conflict-abcdef12.md');
  });
});
