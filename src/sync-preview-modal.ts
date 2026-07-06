import { type App, Modal, Setting } from 'obsidian';

export interface SyncPreview {
  incoming: number; // files to receive from the cloud (a pull will change them)
  outgoing: number; // local working changes to send up
  firstSync: boolean; // no local repo yet - first sync sets things up
}

// The post-sign-in sync popup: shows how many files will sync each way, then runs the
// sync and reports the result. Informational + non-blocking (the sync auto-starts).
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
      counts.createDiv({ text: `↓ ${p.incoming} file(s) to receive (from cloud)` });
      counts.createDiv({ text: `↑ ${p.outgoing} file(s) to send (to cloud)` });
    }

    const statusEl = contentEl.createEl('p', { text: 'Syncing both ways…' });
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
