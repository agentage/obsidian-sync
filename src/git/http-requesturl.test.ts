import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { requestUrlHttpClient } from './http-requesturl';
import { arrayBufferToAsyncIterator, asyncIteratorToArrayBuffer } from './stream-utils';

// Mock Obsidian's requestUrl (the only Obsidian coupling); everything else is real.
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
const mockRequestUrl = vi.mocked(requestUrl);
// requestUrl accepts `string | RequestUrlParam`; the adapter always passes the object.
const argOf = (i = 0): RequestUrlParam => mockRequestUrl.mock.calls[i][0] as RequestUrlParam;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const fakeRes = (
  status: number,
  bodyText = '',
  headers: Record<string, string> = {}
): RequestUrlResponse =>
  ({
    status,
    headers,
    arrayBuffer: enc(bodyText).buffer as ArrayBuffer,
    json: null,
    text: bodyText,
  }) as RequestUrlResponse;

const readBody = async (iter: AsyncIterableIterator<Uint8Array>): Promise<string> =>
  new TextDecoder().decode(new Uint8Array(await asyncIteratorToArrayBuffer(iter)));

beforeEach(() => mockRequestUrl.mockReset());

describe('requestUrlHttpClient (isomorphic-git HttpClient over Obsidian requestUrl)', () => {
  it('GETs with no body + throw:false, exposes the status, and streams the response body', async () => {
    mockRequestUrl.mockResolvedValue(
      fakeRes(200, 'pack-data', { 'content-type': 'application/x-git-upload-pack-advertisement' })
    );

    const res = await requestUrlHttpClient.request({
      url: 'https://sync.example/app.git/info/refs',
      method: 'GET',
    });

    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    const arg = argOf();
    expect(arg).toMatchObject({
      url: 'https://sync.example/app.git/info/refs',
      method: 'GET',
      throw: false,
    });
    expect(arg.body).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'application/x-git-upload-pack-advertisement',
    });
    expect(await readBody(res.body as AsyncIterableIterator<Uint8Array>)).toBe('pack-data');
  });

  it('defaults the method to GET when omitted', async () => {
    mockRequestUrl.mockResolvedValue(fakeRes(200));
    const res = await requestUrlHttpClient.request({ url: 'https://sync.example/x' });
    expect(argOf().method).toBe('GET');
    expect(res.method).toBe('GET');
  });

  it('buffers a streamed request body to one ArrayBuffer and forwards the auth header (token never in URL)', async () => {
    mockRequestUrl.mockResolvedValue(fakeRes(200, 'ok'));

    await requestUrlHttpClient.request({
      url: 'https://sync.example/app.git/git-upload-pack',
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'content-type': 'application/x-git-upload-pack-request',
      },
      body: arrayBufferToAsyncIterator(enc('0009done\n').buffer as ArrayBuffer),
    });

    const arg = argOf();
    expect(arg.method).toBe('POST');
    expect(arg.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
    expect(arg.url).not.toContain('secret-token');
    expect(arg.body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(new Uint8Array(arg.body as ArrayBuffer))).toBe('0009done\n');
  });

  it('maps the status to a reason phrase (isomorphic-git HttpError needs words, not the code)', async () => {
    mockRequestUrl.mockResolvedValue(fakeRes(401));
    expect((await requestUrlHttpClient.request({ url: 'u' })).statusMessage).toBe('Unauthorized');

    mockRequestUrl.mockResolvedValue(fakeRes(409));
    expect((await requestUrlHttpClient.request({ url: 'u' })).statusMessage).toBe('Conflict');

    // Unknown code -> empty string (never the numeric code, which would read as "HTTP Error: 418 418").
    mockRequestUrl.mockResolvedValue(fakeRes(418));
    expect((await requestUrlHttpClient.request({ url: 'u' })).statusMessage).toBe('');
  });
});
