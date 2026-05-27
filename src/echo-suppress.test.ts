import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEchoSuppress } from './echo-suppress';

describe('createEchoSuppress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when no mark was recorded', () => {
    const echo = createEchoSuppress();
    expect(echo.consume('a.md')).toBe(false);
  });

  it('consume returns true once after a mark, then false (one-shot)', () => {
    const echo = createEchoSuppress();
    echo.mark('a.md');
    expect(echo.consume('a.md')).toBe(true);
    expect(echo.consume('a.md')).toBe(false);
  });

  it('per-path: marking one path does not consume another', () => {
    const echo = createEchoSuppress();
    echo.mark('a.md');
    expect(echo.consume('b.md')).toBe(false);
    expect(echo.consume('a.md')).toBe(true);
  });

  it('expires marks older than the TTL (default 5 s)', () => {
    const echo = createEchoSuppress();
    echo.mark('a.md');
    vi.advanceTimersByTime(6_000);
    expect(echo.consume('a.md')).toBe(false);
  });

  it('honours a custom TTL', () => {
    const echo = createEchoSuppress(1_000);
    echo.mark('a.md');
    vi.advanceTimersByTime(500);
    expect(echo.consume('a.md')).toBe(true);
    echo.mark('a.md');
    vi.advanceTimersByTime(1_500);
    expect(echo.consume('a.md')).toBe(false);
  });
});
