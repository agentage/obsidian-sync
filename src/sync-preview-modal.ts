import { type App, Modal, Setting } from 'obsidian';

export interface SyncPreview {
  pending: number; // local md files the next sync would push up (content differs from the push cache)
  firstSync: boolean; // no memory chosen / not signed in yet - nothing to preview
}

// The post-sign-in sync popup: on the couch channel the incoming count is only known after a
// pull, so we show the honest outgoing figure (local files whose content differs from what was
// last pushed - EVERY md file on a fresh memory) then run the live sync and report the result.
// Informational + non-blocking (the sync auto-starts).
class SyncPreviewModal extends Modal {
  constructor(
    app: App,
    private getPreview: () => Promise<SyncPreview>,
    private runSync: () => Promise<{ ok: boolean; message: string }>
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, titleEl } = this;
    titleEl.setText('Agentage Sync');

    const checking = contentEl.createEl('p', { text: 'Checking what needs to sync…' });
    let p: SyncPreview;
    try {
      p = await this.getPreview();
    } catch (e) {
      checking.setText(`Couldn't check: ${(e as Error).message}`);
      this.addClose();
      return;
    }
    checking.remove();

    const counts = contentEl.createDiv({ cls: 'ams-sync-counts' });
    if (p.firstSync) {
      counts.createDiv({ text: '⟳ First sync - setting up your memory.' });
    } else {
      counts.createDiv({ text: `↑ ${p.pending} local change(s) to send (to cloud)` });
    }

    const statusEl = contentEl.createEl('p', { text: 'Syncing…' });
    try {
      const r = await this.runSync();
      statusEl.setText(r.message);
    } catch (e) {
      statusEl.setText(`Sync failed: ${(e as Error).message}`);
    }
    this.addClose();
  }

  private addClose(): void {
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText('Close')
        .setCta()
        .onClick(() => this.close())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function openSyncPreview(
  app: App,
  getPreview: () => Promise<SyncPreview>,
  runSync: () => Promise<{ ok: boolean; message: string }>
): void {
  new SyncPreviewModal(app, getPreview, runSync).open();
}
