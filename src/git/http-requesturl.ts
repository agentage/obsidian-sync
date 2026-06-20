// isomorphic-git HttpClient backed by Obsidian's requestUrl (bypasses CORS on
// desktop AND mobile, no proxy). requestUrl can't stream, so the body is buffered
// to one ArrayBuffer and the response is re-wrapped as a single-chunk iterator.
// Obsidian-only (wired in main); the pure buffer helpers live in stream-utils (tested).
import { requestUrl } from 'obsidian';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';
import { arrayBufferToAsyncIterator, asyncIteratorToArrayBuffer } from './stream-utils';

// isomorphic-git interpolates statusMessage into its HttpError (`HTTP Error: <code> <msg>`),
// so it must be a reason phrase, not the numeric code repeated.
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export const requestUrlHttpClient: HttpClient = {
  async request({ url, method, headers, body }: GitHttpRequest): Promise<GitHttpResponse> {
    const usedMethod = method ?? 'GET';
    const collectedBody = body ? await asyncIteratorToArrayBuffer(body) : undefined;
    const res = await requestUrl({
      url,
      method: usedMethod,
      headers: headers as Record<string, string> | undefined,
      body: collectedBody,
      throw: false, // isomorphic-git inspects statusCode itself
    });
    return {
      url,
      method: usedMethod,
      headers: res.headers,
      body: arrayBufferToAsyncIterator(res.arrayBuffer),
      statusCode: res.status,
      statusMessage: STATUS_TEXT[res.status] ?? '',
    };
  },
};
