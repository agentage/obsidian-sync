import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import { openSyncPreview, type SyncPreview } from './sync-preview-modal';

// Fake of the Obsidian element surface the modal touches (createEl/createDiv/setText/
// remove/empty), enough to assert what the user would read in the popup.
interface FakeEl {
  text: string;
  cls?: string;
  children: FakeEl[];
  parent?: FakeEl;
  setText(t: string): void;
  remove(): void;
  createEl(tag: string, o?: { text?: string; cls?: string }): FakeEl;
  createDiv(o?: { text?: string; cls?: string }): FakeEl;
  empty(): void;
}

interface ModalHandle {
  titleEl: FakeEl;
  contentEl: FakeEl;
  onOpenDone: Promise<void>;
}

const h = vi.hoisted(() => {
  interface El {
    text: string;
    cls?: string;
    children: El[];
    parent?: El;
    setText(t: string): void;
    remove(): void;
    createEl(tag: string, o?: { text?: string; cls?: string }): El;
    createDiv(o?: { text?: string; cls?: string }): El;
    empty(): void;
  }
  const makeEl = (text = '', cls?: string): El => {
    const el: El = {
      text,
      cls,
      children: [],
      setText(t) {
        el.text = t;
      },
      remove() {
        const sib = el.parent?.children;
        if (sib) sib.splice(sib.indexOf(el), 1);
      },
      createEl(_tag, o) {
        const child = makeEl(o?.text ?? '', o?.cls);
        child.parent = el;
        el.children.push(child);
        return child;
      },
      createDiv(o) {
        return el.createEl('div', o);
      },
      empty() {
        el.children = [];
      },
    };
    return el;
  };
  return {
    makeEl,
    modals: [] as unknown[],
    clicks: [] as Array<() => void>,
  };
});

// The modal only needs Modal (titleEl/contentEl/open/close) and Setting (addButton chain).
vi.mock('obsidian', () => {
  class Modal {
    titleEl = h.makeEl();
    contentEl = h.makeEl();
    onOpenDone: Promise<void> = Promise.resolve();
    constructor(_app: unknown) {
      h.modals.push(this);
    }
    open(): void {
      this.onOpenDone = (this as unknown as { onOpen(): Promise<void> }).onOpen();
    }
    close(): void {
      (this as unknown as { onClose(): void }).onClose();
    }
  }
  interface ButtonStub {
    setButtonText(t: string): ButtonStub;
    setCta(): ButtonStub;
    onClick(fn: () => void): ButtonStub;
  }
  class Setting {
    constructor(_el: unknown) {}
    addButton(cb: (b: ButtonStub) => unknown): this {
      const btn: ButtonStub = {
        setButtonText: () => btn,
        setCta: () => btn,
        onClick: (fn) => {
          h.clicks.push(fn);
          return btn;
        },
      };
      cb(btn);
      return this;
    }
  }
  return { Modal, Setting };
});

const app = {} as App;
const lastModal = (): ModalHandle => h.modals[h.modals.length - 1] as ModalHandle;
const allText = (el: FakeEl): string =>
  [el.text, ...el.children.map(allText)].filter(Boolean).join('\n');
const okSync = async (): Promise<{ ok: boolean; message: string }> => ({
  ok: true,
  message: 'personal: synced + pushed',
});

beforeEach(() => {
  h.modals.length = 0;
  h.clicks.length = 0;
});

describe('sync-preview-modal', () => {
  it('shows the couch pending-push count, then runs the sync and reports its result', async () => {
    const preview: SyncPreview = { pending: 3, firstSync: false };
    const runSync = vi.fn(okSync);
    openSyncPreview(app, async () => preview, runSync);
    const m = lastModal();
    await m.onOpenDone;

    expect(m.titleEl.text).toBe('Agentage Sync');
    const text = allText(m.contentEl);
    expect(text).toContain('3 local change(s) to send');
    expect(text).toContain('personal: synced + pushed');
    expect(text).not.toContain('Checking what needs to sync'); // progress line was removed
    expect(runSync).toHaveBeenCalledOnce();
  });

  it('shows the first-sync line instead of the count when nothing is chosen yet', async () => {
    openSyncPreview(app, async () => ({ pending: 0, firstSync: true }), okSync);
    await lastModal().onOpenDone;
    const text = allText(lastModal().contentEl);
    expect(text).toContain('First sync');
    expect(text).not.toContain('to send');
  });

  it('reports a preview failure and never starts the sync', async () => {
    const runSync = vi.fn(okSync);
    openSyncPreview(
      app,
      async () => {
        throw new Error('offline');
      },
      runSync
    );
    await lastModal().onOpenDone;
    expect(allText(lastModal().contentEl)).toContain("Couldn't check: offline");
    expect(runSync).not.toHaveBeenCalled();
  });

  it('surfaces a sync failure in the modal', async () => {
    openSyncPreview(
      app,
      async () => ({ pending: 0, firstSync: false }),
      async () => {
        throw new Error('push denied');
      }
    );
    await lastModal().onOpenDone;
    expect(allText(lastModal().contentEl)).toContain('Sync failed: push denied');
  });

  it('the Close button closes the modal and empties its content', async () => {
    openSyncPreview(app, async () => ({ pending: 0, firstSync: false }), okSync);
    const m = lastModal();
    await m.onOpenDone;
    expect(h.clicks).toHaveLength(1);
    h.clicks[0]();
    expect(m.contentEl.children).toHaveLength(0);
  });
});
