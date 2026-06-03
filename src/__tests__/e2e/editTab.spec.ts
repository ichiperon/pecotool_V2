import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: 編集タブの各操作確認
 * - Undo/Redo ボタンの有効/無効状態
 * - 追加モード / 分割モード / 湾曲モードのトグル
 * - グループ化 / 削除ボタンの無効/有効状態
 */
test.describe('EditTab: 構造操作系ボタンの状態と動作', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
    await loadFixtureDocument(page);
    // 編集タブを開く
    await page.locator('[role="tablist"] button', { hasText: '編集' }).click();
  });

  test('[ET-01] 初期状態で Undo/Redo ボタンは無効', async ({ page }) => {
    await expect(page.locator('button', { hasText: 'Undo' })).toBeDisabled();
    await expect(page.locator('button', { hasText: 'Redo' })).toBeDisabled();
  });

  test('[ET-02] テキスト編集後に Undo ボタンが有効になる', async ({ page }) => {
    // エディタでテキストを編集して dirty にする
    await page.locator('[role="tablist"] button', { hasText: 'ファイル' }).click();
    const editable = page.locator('.ocr-card').first().locator('[contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('UNDO_TEST');
    await editable.blur();

    // 編集タブに戻る
    await page.locator('[role="tablist"] button', { hasText: '編集' }).click();
    await expect(page.locator('button', { hasText: 'Undo' })).toBeEnabled();
  });

  test('[ET-03] 追加ボタンをクリックすると描画モードがトグルされる', async ({ page }) => {
    const addBtn = page.locator('button', { hasText: '追加' });
    await expect(addBtn).toBeEnabled();
    await addBtn.click();
    await expect(addBtn).toHaveClass(/active/);

    // もう一度クリックで解除
    await addBtn.click();
    await expect(addBtn).not.toHaveClass(/active/);
  });

  test('[ET-04] 選択なし状態ではグループ化・削除ボタンが無効', async ({ page }) => {
    await expect(page.locator('button', { hasText: 'グループ化' })).toBeDisabled();
    // '削除' は '重複削除' と '削除' (title="削除") で複数ヒットするため title 属性で絞り込む
    await expect(page.locator('button[title="削除"]')).toBeDisabled();
  });

  test('[ET-05] カードを 1 枚選択すると削除ボタンが有効になる', async ({ page }) => {
    await page.locator('.ocr-card').first().click();

    // 編集タブに切り替え
    await page.locator('[role="tablist"] button', { hasText: '編集' }).click();
    // 削除は 1 件でも有効 (title="削除" で exact 絞り込み)
    await expect(page.locator('button[title="削除"]')).toBeEnabled();
    // グループ化は 2 件以上必要なので無効のまま
    await expect(page.locator('button', { hasText: 'グループ化' })).toBeDisabled();
  });

  test('[ET-06] カードを 2 枚選択するとグループ化ボタンが有効になる', async ({ page }) => {
    const cards = page.locator('.ocr-card');
    await cards.nth(0).click();
    await cards.nth(1).click({ modifiers: ['Control'] });

    await page.locator('[role="tablist"] button', { hasText: '編集' }).click();
    await expect(page.locator('button', { hasText: 'グループ化' })).toBeEnabled();
  });
});
