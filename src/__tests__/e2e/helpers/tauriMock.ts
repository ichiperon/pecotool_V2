import type { Page } from '@playwright/test';

/**
 * Installs Tauri IPC mock shims into the page context.
 * Must be called via page.addInitScript() before any navigation.
 *
 * Also suppresses the onboarding tour by pre-setting the localStorage flag
 * so the modal does not intercept pointer events during tests.
 */
export async function installTauriMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Suppress the first-run onboarding tour so it does not block clicks.
    try {
      localStorage.setItem('pecotool.onboardingShown', 'true');
    } catch {
      // ignore if localStorage is not available
    }
    const callbacks = new Map<number, (payload: unknown) => void>();
    const invokeHistory: Array<{ cmd: string; args?: unknown }> = [];
    const previewWindows = new Set<string>();
    let callbackId = 1;

    (window as any).__TAURI_INVOKE_HISTORY__ = invokeHistory;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    };

    const knownInvokes: Record<string, (args?: any) => unknown> = {
      'plugin:event|listen': (args) => args?.handler ?? 0,
      'plugin:event|unlisten': () => null,
      'plugin:event|emit': () => null,
      'plugin:window|get_all_windows': () => ['main', ...previewWindows],
      'plugin:webview|create_webview_window': (args) => {
        previewWindows.add(args?.label ?? 'preview-window');
        return null;
      },
      'plugin:window|show': () => null,
      'plugin:window|hide': () => null,
      'plugin:window|set_focus': () => null,
      check_pending_backups: () => [],
      clear_backup: () => null,
      save_backup: () => null,
      load_meiryo_font: () => {
        throw new Error('not available in e2e browser');
      },
      // File dialog mocks
      'plugin:dialog|open': () => null,
      'plugin:dialog|save': () => '/mock/output.pdf',
      'plugin:dialog|ask': () => false, // default: user cancels confirmation dialogs
      // Filesystem mocks
      'plugin:fs|write_file': () => null,
      'plugin:fs|write_text_file': () => null,
      'plugin:fs|read_text_file': () => '',
      'plugin:opener|open_path': () => null,
      // Update check mock
      check_update: () => ({ updateAvailable: false }),
    };

    (window as any).__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
      callbacks,
      transformCallback: (callback: (payload: unknown) => void, once = false) => {
        const id = callbackId++;
        callbacks.set(id, (payload: unknown) => {
          if (once) callbacks.delete(id);
          callback(payload);
        });
        return id;
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id);
      },
      runCallback: (id: number, payload: unknown) => {
        callbacks.get(id)?.(payload);
      },
      convertFileSrc: (filePath: string) =>
        `http://asset.localhost/${encodeURIComponent(filePath)}`,
      invoke: async (cmd: string, args?: any) => {
        const handler = knownInvokes[cmd];
        if (!handler) throw new Error(`[e2e tauri mock] Unknown invoke: ${cmd}`);
        invokeHistory.push({ cmd, args });
        return handler(args);
      },
    };
  });
}

/** Returns the Tauri invoke call history recorded by the mock. */
export async function getTauriInvokeHistory(
  page: Page,
): Promise<Array<{ cmd: string; args?: unknown }>> {
  return page.evaluate(
    () => (window as any).__TAURI_INVOKE_HISTORY__ ?? [],
  ) as Promise<Array<{ cmd: string; args?: unknown }>>;
}

/**
 * Loads a 2-page fixture document into the pecoStore.
 * Waits until at least one .ocr-card is visible.
 */
export async function loadFixtureDocument(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { usePecoStore } = await import('/src/store/pecoStore.ts');
    usePecoStore.getState().setDocument({
      filePath: 'e2e-fixture.pdf',
      fileName: 'e2e-fixture.pdf',
      totalPages: 2,
      metadata: {},
      pages: new Map([
        [
          0,
          {
            width: 600,
            height: 800,
            rotation: 0,
            textBlocks: [
              {
                id: 'block-1',
                text: '最初のOCRテキスト',
                bbox: { x: 80, y: 90, width: 160, height: 32 },
                writingMode: 'horizontal',
                order: 0,
                isDirty: false,
              },
              {
                id: 'block-2',
                text: '二つ目のOCRテキスト',
                bbox: { x: 80, y: 150, width: 180, height: 32 },
                writingMode: 'horizontal',
                order: 1,
                isDirty: false,
              },
            ],
            isTextExtracted: true,
            isDirty: false,
          },
        ],
        [
          1,
          {
            width: 600,
            height: 800,
            rotation: 0,
            textBlocks: [
              {
                id: 'block-3',
                text: '2ページ目',
                bbox: { x: 60, y: 80, width: 120, height: 30 },
                writingMode: 'horizontal',
                order: 0,
                isDirty: false,
              },
            ],
            isTextExtracted: true,
            isDirty: false,
          },
        ],
      ]),
    });
  });
  const { expect } = await import('@playwright/test');
  await expect(page.locator('.ocr-card').first()).toBeVisible({ timeout: 15000 });
}
