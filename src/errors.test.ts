import { describe, expect, it } from 'vitest';
import { describeErr } from './errors';

describe('describeErr', () => {
  it("returns 'unknown' for null/undefined", () => {
    expect(describeErr(null)).toBe('unknown');
    expect(describeErr(undefined)).toBe('unknown');
  });

  it('stringifies non-object primitives', () => {
    expect(describeErr(404)).toBe('404');
    expect(describeErr('boom')).toBe('boom');
  });

  it('returns the useful fields from an object', () => {
    const err = {
      name: 'unauthorized',
      message: 'You are not authorized to access this db.',
      status: 401,
      reason: 'You are not authorized to access this db.',
      error: 'unauthorized',
      docId: 'notes/a.md',
      stack: 'long stack that we drop',
    };
    expect(describeErr(err)).toEqual({
      name: 'unauthorized',
      message: 'You are not authorized to access this db.',
      status: 401,
      reason: 'You are not authorized to access this db.',
      error: 'unauthorized',
      docId: 'notes/a.md',
    });
  });

  it('returns undefined for missing fields rather than throwing', () => {
    const r = describeErr({ message: 'oops' }) as Record<string, unknown>;
    expect(r.message).toBe('oops');
    expect(r.status).toBeUndefined();
  });
});
