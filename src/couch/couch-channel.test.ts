import { describe, it, expect, vi } from 'vitest';
import { CouchChannel } from './couch-channel';
import type { CouchSync } from './couch-sync';

// A CouchSync stand-in with spied delegation methods (the channel only calls these three).
const fakeSync = (): CouchSync =>
  ({
    tick: vi.fn(async () => {}),
    pushFileLive: vi.fn(async (_p: string) => {}),
    removeFile: vi.fn(async (_p: string) => {}),
  }) as unknown as CouchSync;

describe('CouchChannel', () => {
  it('builds once per memory and reuses the live controller', () => {
    const a = fakeSync();
    const build = vi.fn(() => a);
    const ch = new CouchChannel();
    expect(ch.for('A', build)).toBe(a);
    expect(ch.for('A', build)).toBe(a); // same memory -> no rebuild
    expect(build).toHaveBeenCalledTimes(1);
    expect(ch.active).toBe(true);
  });

  it('rebuilds on a memory switch', () => {
    const a = fakeSync();
    const b = fakeSync();
    const ch = new CouchChannel();
    ch.for('A', () => a);
    expect(ch.for('B', () => b)).toBe(b);
  });

  it('delegates tick/push/remove to the live controller', async () => {
    const a = fakeSync();
    const ch = new CouchChannel();
    ch.for('A', () => a);
    await ch.tick();
    await ch.pushFileLive('n.md');
    await ch.removeFile('o.md');
    expect(a.tick).toHaveBeenCalledOnce();
    expect(a.pushFileLive).toHaveBeenCalledWith('n.md');
    expect(a.removeFile).toHaveBeenCalledWith('o.md');
  });

  // D2: after clear() a stale controller must not touch the previous memory's db.
  it('clear tears the controller down so tick + handlers no-op, then a switch back rebuilds', async () => {
    const a = fakeSync();
    const ch = new CouchChannel();
    ch.for('A', () => a);
    ch.clear();
    expect(ch.active).toBe(false);
    await ch.tick();
    await ch.pushFileLive('x.md');
    await ch.removeFile('y.md');
    expect(a.tick).not.toHaveBeenCalled();
    expect(a.pushFileLive).not.toHaveBeenCalled();
    expect(a.removeFile).not.toHaveBeenCalled();
    const a2 = fakeSync();
    expect(ch.for('A', () => a2)).toBe(a2); // memory A comes back -> fresh controller
  });
});
