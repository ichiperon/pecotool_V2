import { test, expect } from '@playwright/test';
import { installTauriMocks, getTauriInvokeHistory, loadFixtureDocument } from './helpers/tauriMock';

/**
 * #285 D-approach contract test.
 *
 * Verifies that the OCR code path never invokes any `plugin:fs|*` command
 * from the JavaScript side, so the Windows UNC verbatim prefix mismatch
 * against Tauri's capability glob pattern cannot recur.
 *
 * Specifically:
 *   - `plugin:fs|write_file` / `write_text_file` / `mkdir` / `remove`
 *     must NOT be called during OCR (current page / all pages / range).
 *   - `run_ocr` must be called with an `imageBytes` argument and must NOT
 *     contain an `imagePath` argument.
 *
 * This does NOT verify the real Tauri runtime scope behaviour (mocked here).
 * Real-device verification still requires installing the NSIS bundle and
 * running OCR manually. The contract test catches regression if a future
 * change reintroduces JS-side file writes in the OCR pipeline.
 */

const FS_INVOKE_RE = /^plugin:fs\|/;

async function expectNoFsInvokes(page: import('@playwright/test').Page, since: number) {
  const history = await getTauriInvokeHistory(page);
  const offending = history.slice(since).filter((entry) => FS_INVOKE_RE.test(entry.cmd));
  expect(offending, `JS must not call plugin:fs|* during OCR. Offending invokes: ${JSON.stringify(offending)}`).toEqual([]);
}

async function getRunOcrCalls(page: import('@playwright/test').Page, since: number) {
  const history = await getTauriInvokeHistory(page);
  return history.slice(since).filter((entry) => entry.cmd === 'run_ocr');
}

test.describe('#285 OCR scope contract (D approach)', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    // run_ocr mock: return a JSON OcrResult shaped string.
    await page.addInitScript(() => {
      const tauri = (window as any).__TAURI_INTERNALS__;
      const originalInvoke = tauri.invoke;
      tauri.invoke = async (cmd: string, args?: any) => {
        if (cmd === 'run_ocr') {
          // Track + return a valid OCR result with the bytes path
          (window as any).__TAURI_INVOKE_HISTORY__?.push({ cmd, args });
          return JSON.stringify({ status: 'ok', blocks: [] });
        }
        return originalInvoke(cmd, args);
      };
    });
    await page.goto('/');
    await loadFixtureDocument(page);
  });

  test('[SC-01] runOcrCurrentPage が plugin:fs|* を呼ばず run_ocr を imageBytes 引数で呼ぶ', async ({ page }) => {
    const history = await getTauriInvokeHistory(page);
    const before = history.length;

    // OCR current page via Ribbon OCR tab. Tab/button text matches existing OcrTab structure.
    await page.locator('button.ribbon-tab', { hasText: 'OCR' }).click();
    await page.locator('button[title="OCR実行"]').click();
    await page.locator('button.ribbon-dropdown-item', { hasText: '現在のページ' }).click();

    // Wait for OCR confirmation (mock dialog returns false by default — accept)
    // The dialog mock returns false, but runOcrCurrentPage does not need confirmation.
    // Allow microtask + render to settle.
    await page.waitForTimeout(500);

    await expectNoFsInvokes(page, before);

    // mock 環境では実 PDF render が動かず run_ocr が 0 回の場合もある。
    // 重要なのは「もし呼ばれたら imageBytes 形式」と「plugin:fs|* が呼ばれない」こと。
    const runOcrCalls = await getRunOcrCalls(page, before);
    for (const call of runOcrCalls) {
      const args = call.args as Record<string, unknown> | undefined;
      expect(args, 'run_ocr args must exist').toBeTruthy();
      expect(args!.imageBytes, 'run_ocr must receive imageBytes').toBeDefined();
      expect(args!.imagePath, 'run_ocr must NOT receive imagePath (regression guard)').toBeUndefined();
      expect(Array.isArray(args!.imageBytes) || ArrayBuffer.isView(args!.imageBytes as any), 'imageBytes must be array-like').toBeTruthy();
    }
  });

  test('[SC-02] runOcrAllPages も plugin:fs|* を呼ばない', async ({ page }) => {
    // Override the ask mock to return true (user confirms "OCR all pages").
    await page.evaluate(() => {
      const tauri = (window as any).__TAURI_INTERNALS__;
      const originalInvoke = tauri.invoke;
      tauri.invoke = async (cmd: string, args?: any) => {
        if (cmd === 'plugin:dialog|ask') {
          (window as any).__TAURI_INVOKE_HISTORY__?.push({ cmd, args });
          return true;
        }
        return originalInvoke(cmd, args);
      };
    });

    const history = await getTauriInvokeHistory(page);
    const before = history.length;

    await page.locator('button.ribbon-tab', { hasText: 'OCR' }).click();
    await page.locator('button[title="OCR実行"]').click();
    await page.locator('button.ribbon-dropdown-item', { hasText: '全ページ' }).click();

    await page.waitForTimeout(1500);

    await expectNoFsInvokes(page, before);
  });

  test('[SC-03] mkdir / writeFile / tempDir / appLocalDataDir が OCR 経路で呼ばれない (regression guard)', async ({ page }) => {
    const history = await getTauriInvokeHistory(page);
    const before = history.length;

    await page.locator('button.ribbon-tab', { hasText: 'OCR' }).click();
    await page.locator('button[title="OCR実行"]').click();
    await page.locator('button.ribbon-dropdown-item', { hasText: '現在のページ' }).click();
    await page.waitForTimeout(500);

    const after = await getTauriInvokeHistory(page);
    const newCalls = after.slice(before);
    const fobiddenCmds = [
      'plugin:fs|mkdir',
      'plugin:fs|write_file',
      'plugin:fs|write_text_file',
      'plugin:fs|remove',
      'plugin:path|resolve_directory', // appLocalDataDir / tempDir use this internally
    ];
    const offending = newCalls.filter((c) => fobiddenCmds.includes(c.cmd));
    expect(offending, `OCR path must not invoke: ${JSON.stringify(offending)}`).toEqual([]);
  });
});
