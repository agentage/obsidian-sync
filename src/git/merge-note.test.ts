import { describe, it, expect } from 'vitest';
import { load, dump } from 'js-yaml';
import { mergeNote } from './merge-note';

const note = (fm: Record<string, unknown>, body: string) =>
  `---\n${dump(fm, { lineWidth: -1, sortKeys: false })}---\n${body}`;

describe('mergeNote (R14 frontmatter LWW + union, R15 body diff3 + markers)', () => {
  it('takes the only-changed side per key (theirs)', () => {
    const base = note({ title: 'A', status: 'draft' }, 'body\n');
    const ours = note({ title: 'A', status: 'draft' }, 'body\n');
    const theirs = note({ title: 'A', status: 'done' }, 'body\n');
    const { text, clean } = mergeNote(base, ours, theirs);
    expect(clean).toBe(true);
    expect((load(text.match(/^---\n([\s\S]*?)\n---/)![1]) as { status: string }).status).toBe(
      'done'
    );
  });

  it('takes the only-changed side per key (ours)', () => {
    const base = note({ title: 'A' }, 'b\n');
    const ours = note({ title: 'A-edited' }, 'b\n');
    const theirs = note({ title: 'A' }, 'b\n');
    const { text } = mergeNote(base, ours, theirs);
    expect(text).toContain('title: A-edited');
  });

  it('unions list keys (tags) instead of LWW (no dropped tag)', () => {
    const base = note({ tags: ['x'] }, 'b\n');
    const ours = note({ tags: ['x', 'a'] }, 'b\n');
    const theirs = note({ tags: ['x', 'b'] }, 'b\n');
    const { text } = mergeNote(base, ours, theirs);
    const tags = (load(text.match(/^---\n([\s\S]*?)\n---/)![1]) as { tags: string[] }).tags;
    expect(new Set(tags)).toEqual(new Set(['x', 'a', 'b']));
  });

  it('both-changed scalar → newer `updated` wins (LWW)', () => {
    const base = note({ n: 1, updated: '2026-01-01' }, 'b\n');
    const ours = note({ n: 2, updated: '2026-06-20' }, 'b\n');
    const theirs = note({ n: 3, updated: '2026-03-01' }, 'b\n');
    const { text } = mergeNote(base, ours, theirs);
    expect((load(text.match(/^---\n([\s\S]*?)\n---/)![1]) as { n: number }).n).toBe(2);
  });

  it('merges non-overlapping body edits cleanly (both survive)', () => {
    const base = note({ t: 1 }, 'line1\nline2\nline3\n');
    const ours = note({ t: 1 }, 'OURS\nline2\nline3\n');
    const theirs = note({ t: 1 }, 'line1\nline2\nTHEIRS\n');
    const { text, clean } = mergeNote(base, ours, theirs);
    expect(clean).toBe(true);
    expect(text).toContain('OURS');
    expect(text).toContain('THEIRS');
    expect(text).not.toContain('<<<<<<<');
  });

  it('emits conflict markers on a true body overlap (clean:false)', () => {
    const base = note({ t: 1 }, 'shared\n');
    const ours = note({ t: 1 }, 'mine\n');
    const theirs = note({ t: 1 }, 'yours\n');
    const { text, clean } = mergeNote(base, ours, theirs);
    expect(clean).toBe(false);
    expect(text).toContain('<<<<<<< ours');
    expect(text).toContain('=======');
    expect(text).toContain('>>>>>>> theirs');
  });

  it('REGRESSION: a body conflict never injects markers into the YAML block', () => {
    const base = note({ title: 'A' }, 'shared\n');
    const ours = note({ title: 'A' }, 'mine\n');
    const theirs = note({ title: 'A' }, 'yours\n');
    const { text } = mergeNote(base, ours, theirs);
    const fmRaw = text.match(/^---\n([\s\S]*?)\n---/)![1];
    expect(fmRaw).not.toContain('<<<<<<<');
    expect(() => load(fmRaw)).not.toThrow(); // frontmatter still parses
  });

  it('handles notes with no frontmatter (clean, no --- block)', () => {
    const { text, clean } = mergeNote('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n');
    expect(clean).toBe(true);
    expect(text.startsWith('---')).toBe(false);
    expect(text).toContain('A');
    expect(text).toContain('C');
  });
});
