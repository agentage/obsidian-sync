// isomorphic-git HttpClient backed by Obsidian's requestUrl (bypasses CORS on
// desktop AND mobile, no proxy). requestUrl can't stream, so the body is buffered
// to one ArrayBuffer and the response is re-wrapped as a single-chunk iterator.
// Obsidian-only (wired in main); the pure buffer helpers live in stream-utils (tested).
import { requestUrl } from 'obsidian';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';
import { arrayBufferToAsyncIterator, asyncIteratorToArrayBuffer } from './stream-utils';

export const requestUrlHttpClient: HttpClient = {
  async request({ url, method, headers, body }: GitHttpRequest): Promise<GitHttpResponse> {
    const collectedBody = body ? await asyncIteratorToArrayBuffer(body) : undefined;
    const res = await requestUrl({
      url,
      method: method ?? 'GET',
      headers: headers as Record<string, string> | undefined,
      body: collectedBody,
      throw: false, // isomorphic-git inspects statusCode itself
    });
    return {
      url,
      method,
      headers: res.headers,
      body: arrayBufferToAsyncIterator(res.arrayBuffer),
      statusCode: res.status,
      statusMessage: res.status.toString(),
    };
  },
};
