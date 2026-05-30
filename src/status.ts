/**
 * Pure mapping from sync state to a status-bar icon, hover tooltip, and color.
 * Kept obsidian-free so it can be unit-tested without the Obsidian runtime.
 * `color` is a CSS value the caller applies as `iconEl.style.color` — using
 * Obsidian's theme variables means the icons follow whatever theme the user
 * is on (light/dark/custom).
 */

export type StatusState = 'idle' | 'active' | 'synced' | 'error';

export interface StatusDisplay {
  /** Lucide icon id understood by Obsidian's `setIcon`. */
  iconId: string;
  /** Text shown on hover (set as the status-bar element's `title`). */
  tooltip: string;
  /** CSS color value (Obsidian theme variable) the caller applies to the icon. */
  color: string;
}

const TABLE: Record<StatusState, StatusDisplay> = {
  idle: { iconId: 'circle', tooltip: 'memory: idle', color: 'var(--text-muted)' },
  active: { iconId: 'refresh-cw', tooltip: 'memory: syncing…', color: 'var(--text-accent)' },
  synced: { iconId: 'check', tooltip: 'memory: in sync', color: 'var(--color-green)' },
  error: { iconId: 'alert-circle', tooltip: 'memory: error', color: 'var(--color-red)' },
};

export function statusDisplay(state: StatusState, detail?: string): StatusDisplay {
  const base = TABLE[state];
  if (state === 'error' && detail) {
    return { ...base, tooltip: `${base.tooltip} (${detail})` };
  }
  return base;
}
