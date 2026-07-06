import { describe, it, expect } from 'vitest';
import { startLoopbackServer } from './loopback-server';

// Real node:http listener on 127.0.0.1 - exercises the actual desktop callback path.
describe('loopback-server', () => {
  it('captures the callback query params and serves a success page', async () => {
    const lb = await startLoopbackServer();
    try {
      expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const res = await fetch(`${lb.redirectUri}?code=abc&state=xyz`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('Signed in to Agentage');

      await expect(lb.waitForCode).resolves.toEqual({ code: 'abc', state: 'xyz' });
    } finally {
      lb.close();
    }
  });

  it('surfaces an error param without a code as a problem page', async () => {
    const lb = await startLoopbackServer();
    try {
      const res = await fetch(`${lb.redirectUri}?error=access_denied`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Sign-in problem');
      await expect(lb.waitForCode).resolves.toEqual({ error: 'access_denied' });
    } finally {
      lb.close();
    }
  });

  it('404s a non-callback path and keeps listening', async () => {
    const lb = await startLoopbackServer();
    try {
      const port = new URL(lb.redirectUri).port;
      const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
      expect(res.status).toBe(404);
    } finally {
      lb.close();
    }
  });

  it('binds an ephemeral loopback port (never 0.0.0.0)', async () => {
    const lb = await startLoopbackServer();
    expect(new URL(lb.redirectUri).hostname).toBe('127.0.0.1');
    lb.close();
  });
});
