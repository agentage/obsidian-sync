import { vi } from 'vitest';
import type { FakeVault } from './fake-vault';
import type { FakeSecretStorage } from './fake-secrets';

// The vi.mock('obsidian') factory (lifted from src/main.test.ts) plus a property-shaped fake
// App/Plugin base + a chainable HTMLElement/Setting so the REAL main.ts onload() (which builds
// the status bar and re-renders the settings tab) runs headless. requestUrl is a vi.fn the boot
// wires to the Router afterward (hoist-safe, the colocated-test pattern).

// The shared requestUrl spy - boot points it at Router.requestUrl via mockImplementation.
export const requestUrlMock = vi.fn();

// A self-returning chainable stub: every method returns itself and every unknown property is
// another chainable, so the plugin's fluent DOM/Setting builders (createEl().setText(),
// addButton(b => b.setButtonText().onClick())) run as no-ops without modelling the real DOM.
const chainable = (): unknown => {
  const target = function () {} as unknown as Record<string, unknown>;
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop) {
      if (prop === 'text') return '';
      return proxy;
    },
    apply() {
      return proxy;
    },
  };
  const proxy: unknown = new Proxy(target, handler);
  return proxy;
};

/** The vi.mock('obsidian') factory. Also drives Platform.isDesktopApp so a test can flip it. */
export const obsidianMockFactory = () => {
  class TFile {
    path = '';
    extension = '';
  }
  return {
    FileSystemAdapter: class FileSystemAdapter {},
    Menu: class Menu {
      addItem() {
        return this;
      }
      showAtMouseEvent() {}
    },
    // Inert modal: open()/close() no-op (the base never invokes the subclass onOpen), so the
    // post-sign-in sync popup does not fire a second, timing-dependent sync in the harness.
    Modal: class Modal {
      contentEl = chainable();
      constructor(_app: unknown) {}
      open() {}
      close() {}
    },
    Notice: class Notice {},
    Platform: { isDesktopApp: true },
    Plugin: class Plugin {
      app: unknown;
      manifest: unknown;
      constructor(app: unknown, manifest: unknown) {
        this.app = app;
        this.manifest = manifest;
      }
      addSettingTab() {}
      addRibbonIcon() {
        return chainable();
      }
      addStatusBarItem() {
        return chainable();
      }
      addCommand() {}
      registerObsidianProtocolHandler() {}
      registerEvent() {}
      registerInterval() {}
      registerDomEvent() {}
      loadData() {
        return Promise.resolve(null);
      }
      saveData() {
        return Promise.resolve();
      }
    },
    PluginSettingTab: class PluginSettingTab {
      containerEl = chainable();
      constructor(_app: unknown, _plugin: unknown) {}
    },
    FuzzySuggestModal: class FuzzySuggestModal {},
    // A chainable no-op builder: new Setting(el).setName().addButton(b => b.onClick())…
    Setting: class Setting {
      constructor(_containerEl: unknown) {
        return chainable() as Setting;
      }
    },
    TFile,
    requestUrl: requestUrlMock,
    normalizePath: (p: string) => p,
    debounce: (fn: unknown) => fn,
  };
};

/** A property-shaped fake Obsidian App: the vault event emitter + the secretStorage shim. */
export const makeFakeApp = (vault: FakeVault, secretStorage: FakeSecretStorage): unknown => ({
  vault,
  secretStorage,
  setting: { open: () => {}, openTabById: () => {} },
});
