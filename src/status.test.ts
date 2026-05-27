import { describe, expect, it } from 'vitest';
import { statusDisplay } from './status';

describe('statusDisplay', () => {
  it('idle → open circle, muted color', () => {
    expect(statusDisplay('idle')).toEqual({
      iconId: 'circle',
      tooltip: 'memory: idle',
      color: 'var(--text-muted)',
    });
  });

  it('active → refresh-cw, accent color', () => {
    expect(statusDisplay('active')).toEqual({
      iconId: 'refresh-cw',
      tooltip: 'memory: syncing…',
      color: 'var(--text-accent)',
    });
  });

  it('synced → check, green', () => {
    expect(statusDisplay('synced')).toEqual({
      iconId: 'check',
      tooltip: 'memory: in sync',
      color: 'var(--color-green)',
    });
  });

  it('error → alert-circle, red', () => {
    expect(statusDisplay('error')).toEqual({
      iconId: 'alert-circle',
      tooltip: 'memory: error',
      color: 'var(--color-red)',
    });
  });

  it('appends a parenthesised detail when error has one (color unchanged)', () => {
    expect(statusDisplay('error', '401')).toEqual({
      iconId: 'alert-circle',
      tooltip: 'memory: error (401)',
      color: 'var(--color-red)',
    });
  });

  it('ignores detail on non-error states', () => {
    expect(statusDisplay('synced', 'ignored')).toEqual({
      iconId: 'check',
      tooltip: 'memory: in sync',
      color: 'var(--color-green)',
    });
  });
});
