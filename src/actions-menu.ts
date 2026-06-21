import { type App, FuzzySuggestModal } from 'obsidian';

// One action the plugin can offer (Sync now, Choose memory, …). Shared by the desktop
// status-bar Menu and this modal so both stay in sync.
export interface PluginAction {
  title: string;
  icon?: string;
  run: () => void;
}

// A modal action-picker. Unlike Menu.showAtMouseEvent (a desktop popup that does not
// render from a tap on mobile), a SuggestModal renders reliably on mobile — the pattern
// BRAT uses for its ribbon menu.
class ActionsModal extends FuzzySuggestModal<PluginAction> {
  constructor(
    app: App,
    private readonly actions: PluginAction[]
  ) {
    super(app);
    this.setPlaceholder('Agentage Sync');
  }
  getItems(): PluginAction[] {
    return this.actions;
  }
  getItemText(a: PluginAction): string {
    return a.title;
  }
  onChooseItem(a: PluginAction): void {
    a.run();
  }
}

/** Open the action-picker modal (mobile-safe; used by the ribbon + the command). */
export function openActionsMenu(app: App, actions: PluginAction[]): void {
  new ActionsModal(app, actions).open();
}
