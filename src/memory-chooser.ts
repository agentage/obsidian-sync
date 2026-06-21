import { type App, Modal, Notice, Setting } from 'obsidian';
import type { VaultInfo } from './settings';

// What the chooser needs from the plugin. Kept narrow so it doesn't depend on main.
export interface MemoryChooserHost {
  listVaults(): Promise<VaultInfo[]>;
  createVault(name: string): Promise<{ ok: boolean; vault?: string; error?: string }>;
  defaultVaultName(): string;
  selectVault(name: string): Promise<void>;
  syncVault(name: string): Promise<void>; // select + sync now
  currentVault(): string;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

// "12 files · 3 folders · updated 2026-06-20", or "empty" for a new memory.
const describeVault = (v: VaultInfo): string => {
  if (v.empty || (v.files === 0 && v.folders === 0)) return 'empty';
  const bits = [plural(v.files, 'file')];
  if (v.folders) bits.push(plural(v.folders, 'folder'));
  if (v.updated) bits.push(`updated ${v.updated.slice(0, 10)}`);
  return bits.join(' · ');
};

// One dialog: pick an existing memory (each row = a "Use" button) OR create a new one
// (name + "Create & use"). The list loads async; the create section is always shown.
class MemoryModal extends Modal {
  private name: string;
  private listEl!: HTMLElement;

  constructor(
    app: App,
    private readonly host: MemoryChooserHost
  ) {
    super(app);
    this.name = host.defaultVaultName();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Choose a memory' });
    contentEl.createEl('p', {
      cls: 'ams-hint',
      text: 'Pick the memory this vault syncs into, or create a new one.',
    });

    this.listEl = contentEl.createDiv();
    this.listEl.createEl('p', { text: 'Loading your memories…', cls: 'ams-hint' });

    contentEl.createEl('h4', { text: 'Create a new memory' });
    new Setting(contentEl)
      .setName('Name')
      .setDesc('Lowercase letters, numbers, - and _ (max 64).')
      .addText((t) => {
        t.setValue(this.name).onChange((v) => (this.name = v));
        t.inputEl.focus();
        t.inputEl.select();
      });
    new Setting(contentEl).addButton((b) =>
      b
        .setCta()
        .setButtonText('Create & use')
        .onClick(async () => {
          b.setDisabled(true).setButtonText('Creating…');
          const res = await this.host.createVault(this.name);
          if (res.ok && res.vault) {
            new Notice(`Memory "${res.vault}" ready`);
            await this.host.selectVault(res.vault);
            this.close();
          } else {
            new Notice(`Couldn't create memory: ${res.error ?? 'unknown error'}`);
            b.setDisabled(false).setButtonText('Create & use');
          }
        })
    );

    void this.fillList();
  }

  private async fillList(): Promise<void> {
    const [vaults, cur] = [await this.host.listVaults(), this.host.currentVault()];
    this.listEl.empty();
    if (!vaults.length) {
      this.listEl.createEl('p', { text: 'No memories yet — create one below.', cls: 'ams-hint' });
      return;
    }
    for (const v of vaults) {
      const isCur = v.name === cur;
      const meta = describeVault(v);
      const row = new Setting(this.listEl)
        .setName(v.name)
        .setDesc(isCur ? `current · ${meta}` : meta)
        .addButton((b) =>
          b
            .setButtonText(isCur ? 'In use' : 'Use')
            .setDisabled(isCur)
            .onClick(async () => {
              await this.host.selectVault(v.name);
              this.close();
            })
        );
      // Sync now only for the memory in use; switch to another with Use first.
      if (isCur) {
        row.addButton((b) =>
          b
            .setCta()
            .setButtonText('Sync now')
            .onClick(async () => {
              b.setDisabled(true).setButtonText('Syncing…');
              await this.host.syncVault(v.name);
              this.close();
            })
        );
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Open the memory chooser dialog: pick an existing memory or create a new one. */
export function openMemoryChooser(app: App, host: MemoryChooserHost): void {
  new MemoryModal(app, host).open();
}
