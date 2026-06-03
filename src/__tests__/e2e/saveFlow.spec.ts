import { test, expect } from '@playwright/test';
import { installTauriMocks, getTauriInvokeHistory, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: 保存フロー確認
 * - E-F-03: Ctrl+S で保存ダイアログが開き保存が完了する
 * - E-F-05: テキスト編集後に dirty マーク（*）が表示される
 * - E-F-06: Ctrl+Shift+S で別名保存ダイアログが表示される
 * - E-F-07: 保存完了後に dirty マークが消える
 * - E-F-08: 保存中に別ページを編集すると dirty マークが再表示される（race 確認）
 */
test.describe('SaveFlow: 保存フロー E2E', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
    await loadFixtureDocument(page);
  });

  // ─── helpers ─────────────────────────────────────────────────────────────
  /** OCR カードの 1 枚目テキストを編集して dirty にする */
  async function editFirstCard(page: import('@playwright/test').Page): Promise<void> {
    const editable = page.locator('.ocr-card').first().locator('[contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('SAVE_FLOW_TEST');
    await editable.blur();
    // dirty マーク確認（「未保存」テキストが status-bar に出ること）
    await expect(page.locator('.status-bar')).toContainText(/未保存/, { timeout: 5000 });
  }

  // ─── tests ───────────────────────────────────────────────────────────────

  /**
   * E-F-05: テキスト編集後に dirty マーク（*）が表示される
   */
  test('[E-F-05] テキスト編集後に dirty マークが表示される', async ({ page }) => {
    // 初期状態は dirty でない
    await expect(page.locator('.status-bar')).not.toContainText(/未保存/);

    await editFirstCard(page);

    // dirty マークが出ること（「未保存」または「*」を含むセレクタ）
    await expect(page.locator('.status-bar')).toContainText(/未保存/);
  });

  /**
   * E-F-03: Ctrl+S で保存ハンドラが起動し、DiffPreviewModal が表示される
   *
   * 実保存（stat → readFile → pdf-lib → write_pdf_chunk → replace_pdf_file）は
   * Tauri 実バイナリが必要なため E2E mock 環境では完遂不可。
   * App.tsx では onRequestDiffPreview が設定されており、undoStack に変更がある場合は
   * Ctrl+S で DiffPreviewModal（保存前の変更確認ダイアログ）が表示される。
   * ここでは Ctrl+S → DiffPreviewModal の表示までを確認する。
   */
  test('[E-F-03] Ctrl+S で保存前の変更確認ダイアログが表示される', async ({ page }) => {
    await editFirstCard(page);

    await page.keyboard.press('Control+s');

    // DiffPreviewModal (.diff-preview-dialog) が表示されること
    await expect(page.locator('.diff-preview-dialog')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.diff-preview-dialog')).toContainText(/保存前の変更確認/);
  });

  /**
   * E-F-06: Ctrl+Shift+S で別名保存ダイアログ（SaveDialog）が開く
   *
   * App.tsx の handleSaveAs は isFileLoaded=true のとき setShowSaveDialog(true) を呼ぶ。
   * SaveDialog の modal が DOM に現れることを確認する。
   */
  test('[E-F-06] Ctrl+Shift+S で別名保存ダイアログが開く', async ({ page }) => {
    await editFirstCard(page);

    await page.keyboard.press('Control+Shift+s');

    // SaveDialog コンポーネントが表示されること
    // セレクタは .save-dialog または [role="dialog"] を想定
    await expect(
      page.locator('.save-dialog, [aria-label*="保存"], dialog').first(),
    ).toBeVisible({ timeout: 5000 });
  });

  /**
   * E-F-07: 保存完了後に dirty マークが消える
   *
   * pecoStore.resetDirty() が呼ばれると isDirty=false になり
   * status-bar の「未保存」表示が消えることを確認する。
   * Tauri mock 環境ではファイル書き込みが mock されるため、
   * store を直接操作して保存完了をシミュレートする。
   */
  test('[E-F-07] 保存完了後に dirty マークが消える', async ({ page }) => {
    await editFirstCard(page);
    await expect(page.locator('.status-bar')).toContainText(/未保存/);

    // store の resetDirty を直接呼んで保存完了を疑似再現
    await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      usePecoStore.getState().resetDirty();
    });

    // dirty マークが消えること
    await expect(page.locator('.status-bar')).not.toContainText(/未保存/, { timeout: 5000 });
  });

  /**
   * E-F-08: 保存中に別ページを編集すると dirty マークが再表示される（race 確認）
   *
   * Skip 理由: Tauri invoke mock で疑似遅延が必要。
   * ここでは store 操作のみで疑似検証する（完全な race ではなく保存後の再編集）。
   */
  test('[E-F-08] 保存後に再編集すると dirty マークが再表示される（race 疑似確認）', async ({ page }) => {
    await editFirstCard(page);

    // 一度保存完了をシミュレート
    await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      usePecoStore.getState().resetDirty();
    });

    await expect(page.locator('.status-bar')).not.toContainText(/未保存/, { timeout: 3000 });

    // 保存後に 2 ページ目を編集 → dirty が再出現することを確認
    await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      const state = usePecoStore.getState();
      const page1 = state.document?.pages.get(1);
      if (!page1) return;
      state.updatePageData(1, {
        textBlocks: [
          ...page1.textBlocks,
          {
            id: 'race-test-block',
            text: 'RACE_TEST',
            bbox: { x: 10, y: 10, width: 100, height: 30 },
            writingMode: 'horizontal' as const,
            order: 99,
            isDirty: true,
          },
        ],
        isDirty: true,
      });
    });

    await expect(page.locator('.status-bar')).toContainText(/未保存/, { timeout: 5000 });
  });
});
