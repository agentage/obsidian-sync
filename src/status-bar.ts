import { setIcon } from 'obsidian';
import { statusDisplay, type StatusState } from './status';

/**
 * Render the sync state into the plugin's status-bar element. Obsidian-coupled
 * (needs `setIcon` + the live `HTMLElement`), so it's coverage-excluded and
 * exercised by the E2E suite; the pure state→display mapping is in `status.ts`.
 */
export function renderStatus(statusBar: HTMLElement, state: StatusState, detail?: string): void {
  const { iconId, tooltip, color } = statusDisplay(state, detail);
  statusBar.empty();
  const iconEl = statusBar.createSpan({ cls: 'agentage-memory-status-icon' });
  iconEl.dataset.status = state;
  iconEl.style.color = color;
  setIcon(iconEl, iconId);
  statusBar.title = tooltip;
}
