import { describe, it, expect } from 'vitest';
import {
  chunkBody,
  contentRev,
  encodeFile,
  fileId,
  leafIdsOf,
  pathOf,
  sha256hex,
} from './couch-doc';

describe('sha256hex', () => {
  it('is the standard, deterministic sha256 of the utf8 bytes', async () => {
    // Known vector: sha256("") and sha256("abc").
    expect(await sha256hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(await sha256hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(await sha256hex('abc')).toBe(await sha256hex('abc'));
  });
});

describe('fileId / pathOf', () => {
  it('round-trips a path through the f: prefix', () => {
    expect(fileId('notes/a.md')).toBe('f:notes/a.md');
    expect(pathOf(fileId('notes/a.md'))).toBe('notes/a.md');
  });
});

describe('chunkBody', () => {
  it('returns a single empty chunk for an empty body', () => {
    expect(chunkBody('')).toEqual(['']);
  });
  it('keeps a small body as one chunk', () => {
    expect(chunkBody('hello')).toEqual(['hello']);
  });
  it('splits a body larger than the 64KiB chunk into multiple chunks', () => {
    const body = 'x'.repeat(64 * 1024 + 10);
    const parts = chunkBody(body);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(64 * 1024);
    expect(parts[1]).toHaveLength(10);
    expect(parts.join('')).toBe(body);
  });
});

describe('encodeFile', () => {
  it('builds content-addressed leaf docs + a file doc listing them in order', async () => {
    const { leaves, fileDoc } = await encodeFile('notes/a.md', 'hi');
    const h = await sha256hex('hi');
    expect(leaves).toEqual([{ _id: `h:${h}`, _rev: `1-${h.slice(0, 32)}`, data: 'hi' }]);
    expect(fileDoc).toEqual({
      _id: 'f:notes/a.md',
      type: 'file',
      path: 'notes/a.md',
      size: 2,
      leaves: [`h:${h}`],
    });
  });

  it('leaf ids match leafIdsOf for the same body (the push-skip signature)', async () => {
    const { fileDoc } = await encodeFile('notes/a.md', 'hello world');
    expect(fileDoc.leaves).toEqual(await leafIdsOf('hello world'));
  });
});

describe('contentRev', () => {
  it('joins the ordered leaf ids into a deterministic rev', () => {
    expect(contentRev({ leaves: ['h:a', 'h:b'] })).toBe('h:a,h:b');
  });
});
