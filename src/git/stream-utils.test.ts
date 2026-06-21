import { describe, it, expect } from 'vitest';
import { arrayBufferToAsyncIterator, asyncIteratorToArrayBuffer } from './stream-utils';

async function* fromChunks(chunks: Uint8Array[]): AsyncIterableIterator<Uint8Array> {
  for (const c of chunks) yield c;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

describe('stream-utils', () => {
  it('round-trips a multi-chunk iterator to one ArrayBuffer and back', async () => {
    const chunks = [enc.encode('hello '), enc.encode('git '), enc.encode('world')];
    const buf = await asyncIteratorToArrayBuffer(fromChunks(chunks));
    expect(dec.decode(new Uint8Array(buf))).toBe('hello git world');

    const out: Uint8Array[] = [];
    for await (const c of arrayBufferToAsyncIterator(buf)) out.push(c);
    expect(out).toHaveLength(1); // single-chunk re-wrap
    expect(dec.decode(out[0])).toBe('hello git world');
  });

  it('handles an empty body', async () => {
    const buf = await asyncIteratorToArrayBuffer(fromChunks([]));
    expect(buf.byteLength).toBe(0);
  });
});
