// Pure helpers for the requestUrl-backed isomorphic-git HttpClient: Obsidian's
// requestUrl can't stream, so we buffer the request body to one ArrayBuffer and
// re-wrap the response as a single-chunk async iterator. No Obsidian import →
// unit-testable in Node.

export async function* arrayBufferToAsyncIterator(
  buffer: ArrayBuffer
): AsyncIterableIterator<Uint8Array> {
  yield new Uint8Array(buffer);
}

export async function asyncIteratorToArrayBuffer(
  iterator: AsyncIterableIterator<Uint8Array>
): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of iterator) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
