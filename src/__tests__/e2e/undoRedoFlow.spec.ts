import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: Undo/Redo フロー確認
 * - E-ET-05: Undo → Redo の round-trip でテキストが元に戻る
 * - E-ET-06: Undo × 3 → Redo × 3 の往復で最終状態が一致する
 * - E-CF-02: Ctrl+Z で OCR 結果が元に戻り、再保存で反映される
 */
test.describe('UndoRedoFlow: Undo/Redo round-trip E2E', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
    await loadFixtureDocument(page);
  });

  // ─── helpers ─────────────────────────────────────────────────────────────

  /** 編集タブに切り替えて Undo/Redo ボタンを取得 */
  async function openEditTab(page: import('@playwright/test').Page) {
    await page.locator('[role="tablist"] button', { hasText: '編集' }).click();
    return {
      undoBtn: page.locator('button', { hasText: 'Undo' }),
      redoBtn: page.locator('button', { hasText: 'Redo' }),
    };
  }

  /** OCR カードの最初のテキストを取得 */
  async function getFirstCardText(page: import('@playwright/test').Page): Promise<string> {
    return (
      (await page
        .locator('.ocr-card')
        .first()
        .locator('[contenteditable="true"]')
        .first()
        .textContent()) ?? ''
    );
  }

  /** OCR カード最初のテキストを指定テキストで上書き（blur でコミット） */
  async function typeInFirstCard(
    page: import('@playwright/test').Page,
    text: string,
  ): Promise<void> {
    const editable = page
      .locator('.ocr-card')
      .first()
      .locator('[contenteditable="true"]')
      .first();
    await editable.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(text);
    await editable.blur();
  }

  // ─── tests ───────────────────────────────────────────────────────────────

  /**
   * E-ET-05: Undo → Redo の round-trip でテキストが元に戻る
   */
  test('[E-ET-05] Undo → Redo round-trip でテキストが復元される', async ({ page }) => {
    const originalText = await getFirstCardText(page);

    // テキスト編集 → dirty
    await typeInFirstCard(page, 'UNDO_REDO_TEST');
    const editedText = await getFirstCardText(page);
    expect(editedText).toBe('UNDO_REDO_TEST');
    await expect(page.locator('.status-bar')).toContainText(/未保存/);

    // Undo でオリジナルに戻る
    await page.keyboard.press('Control+z');
    await expect(
      page.locator('.ocr-card').first().locator('[contenteditable="true"]').first(),
    ).toHaveText(originalText);

    // 編集タブの Undo ボタンが無効になる（スタックが空）
    const { undoBtn, redoBtn } = await openEditTab(page);
    await expect(undoBtn).toBeDisabled();
    await expect(redoBtn).toBeEnabled();

    // Redo で編集後に戻る
    await page.keyboard.press('Control+y');
    await expect(
      page.locator('.ocr-card').first().locator('[contenteditable="true"]').first(),
    ).toHaveText(editedText);
  });

  /**
   * E-ET-06: Undo × 3 → Redo × 3 の往復で最終状態が一致する
   */
  test('[E-ET-06] Undo × 3 → Redo × 3 の往復で最終状態が一致する', async ({ page }) => {
    const originalText = await getFirstCardText(page);

    // 3 回別々に編集する（blur ごとに undoStack に 1 entry 積む）
    await typeInFirstCard(page, 'STEP_1');
    await typeInFirstCard(page, 'STEP_2');
    await typeInFirstCard(page, 'STEP_3');

    const finalText = await getFirstCardText(page);
    expect(finalText).toBe('STEP_3');

    // Undo × 3 でオリジナルに戻る
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');

    const afterUndo3 = await getFirstCardText(page);
    expect(afterUndo3).toBe(originalText);

    // Redo × 3 で最終状態に戻る
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+y');

    const afterRedo3 = await getFirstCardText(page);
    expect(afterRedo3).toBe(finalText);

    // dirty マークが残っている（まだ保存していない）
    await expect(page.locator('.status-bar')).toContainText(/未保存/);
  });

  /**
   * E-CF-02: Ctrl+Z で OCR 結果が元に戻り、resetDirty 後も dirty フラグが正しい
   *
   * 「OCR 結果 → 編集 → Undo で OCR 結果に戻る」フローを確認。
   * 保存完了（resetDirty）後も Undo 済み状態なら dirty は残る（undo 自体が dirty 更新）。
   */
  test('[E-CF-02] OCR 編集 → Undo で OCR 結果に戻り dirty が維持される', async ({ page }) => {
    // fixture の最初のカードの OCR テキストを確認
    const ocrText = await getFirstCardText(page);
    expect(ocrText).toBeTruthy();

    // 編集して OCR テキストを上書き
    await typeInFirstCard(page, 'OVERWRITE_OCR');
    await expect(page.locator('.status-bar')).toContainText(/未保存/);

    // Ctrl+Z で元の OCR テキストに戻る
    await page.keyboard.press('Control+z');
    await expect(
      page.locator('.ocr-card').first().locator('[contenteditable="true"]').first(),
    ).toHaveText(ocrText);

    // Undo 後も isDirty は true（undo action 自体が isDirty=true をセットする）
    const isDirty = await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      return usePecoStore.getState().isDirty;
    });
    expect(isDirty).toBe(true);

    // 保存完了をシミュレート（resetDirty）
    await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      usePecoStore.getState().resetDirty();
    });

    await expect(page.locator('.status-bar')).not.toContainText(/未保存/, { timeout: 5000 });

    // Undo スタックと Redo スタックの状態確認
    const stacks = await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      const s = usePecoStore.getState();
      return {
        undoLength: s.undoStack.length,
        redoLength: s.redoStack.length,
      };
    });
    // Undo × 1 後なのでスタックは空、Redo に 1 entry が移動している
    expect(stacks.undoLength).toBe(0);
    expect(stacks.redoLength).toBe(1);
  });

  /**
   * Ribbon 編集タブの Undo/Redo ボタンを使った操作確認
   */
  test('[ET-05/06] Ribbon の Undo ボタンでテキストが巻き戻る', async ({ page }) => {
    const originalText = await getFirstCardText(page);

    // ファイルタブ表示のまま編集（タブ切替なしで ocr-card は見えている）
    await typeInFirstCard(page, 'RIBBON_UNDO_TEST');
    await expect(page.locator('.status-bar')).toContainText(/未保存/);

    // 編集タブを開いて Undo ボタンをクリック
    const { undoBtn, redoBtn } = await openEditTab(page);
    await expect(undoBtn).toBeEnabled();
    await undoBtn.click();

    // store 上の undoStack が空になったことで Undo ボタンが無効になることを確認
    await expect(undoBtn).toBeDisabled({ timeout: 5000 });

    // store の undoStack が空であることを直接確認
    const undoLen = await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      return usePecoStore.getState().undoStack.length;
    });
    expect(undoLen).toBe(0);

    // store 上のテキストが元に戻っていること
    const storedText = await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      const s = usePecoStore.getState();
      const page0 = s.document?.pages.get(0);
      return page0?.textBlocks[0]?.text ?? '';
    });
    expect(storedText).toBe(originalText);

    // Redo ボタンが有効になっている
    await expect(redoBtn).toBeEnabled();
  });
});
