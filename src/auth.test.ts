import { describe, expect, it } from 'vitest';
import { basicAuthProvider } from './auth';

describe('basicAuthProvider', () => {
  it('builds a Basic header from username:password', async () => {
    const provider = basicAuthProvider('admin', 'agentage');
    expect(await provider.authHeader()).toBe('Basic ' + btoa('admin:agentage'));
  });

  it('encodes credentials containing a colon', async () => {
    const provider = basicAuthProvider('user', 'p:ss:word');
    expect(await provider.authHeader()).toBe('Basic ' + btoa('user:p:ss:word'));
  });
});
