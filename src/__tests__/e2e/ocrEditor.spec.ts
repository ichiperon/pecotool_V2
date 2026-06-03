import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: OCR エディタパネルの操作確認
 */
test.describe('OcrEditor: テキスト編集・検索フィルタ・カードナビゲーション', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
    await loadFixtureDocument(page);
  });

  test('[OCR-01] OCR カードのテキストを直接編集できる', async ({ page }) => {
    const firstCard = page.locator('.ocr-card').first();
    const editable = firstCard.locator('[contenteditable="true"]').first();

    await editable.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('編集後テキスト');
    await editable.blur();

    await expect(editable).toHaveText('編集後テキスト');
    // dirty マーク確認
    await expect(page.locator('.status-bar')).toContainText(/未保存/);
  });

  test('[OCR-02] 検索ボックスに入力するとカードがフィルタされる', async ({ page }) => {
    const searchBox = page.locator('input[aria-label="OCRテキストを検索"]');
    await expect(searchBox).toBeVisible();

    // 2 枚全部表示されている
    await expect(page.locator('.ocr-card')).toHaveCount(2);

    await searchBox.fill('最初');
    // フィルタ後 1 件のみ
    await expect(page.locator('.ocr-card')).toHaveCount(1);
    // ヒットカウントバッジが表示される
    await expect(page.locator('.search-hit-badge')).toBeVisible();
  });

  test('[OCR-03] 検索ボックスをクリアするとカードが全件に戻る', async ({ page }) => {
    const searchBox = page.locator('input[aria-label="OCRテキストを検索"]');
    await searchBox.fill('最初');
    await expect(page.locator('.ocr-card')).toHaveCount(1);

    await searchBox.fill('');
    // クリア後全件
    await expect(page.locator('.ocr-card')).toHaveCount(2);
    await expect(page.locator('.search-hit-badge')).not.toBeVisible();
  });

  test('[OCR-04] Ctrl+ArrowDown で次のカードに選択が移動する', async ({ page }) => {
    // 1 枚目をクリックして選択
    const firstCard = page.locator('.ocr-card').first();
    await firstCard.click();
    await expect(firstCard).toHaveClass(/selected/);

    // Ctrl+↓ で 2 枚目に移動
    await page.keyboard.press('Control+ArrowDown');

    const secondCard = page.locator('.ocr-card').nth(1);
    await expect(secondCard).toHaveClass(/selected/);
  });

  test('[OCR-05] 検索フィルタ適用中に DnD 無効のヒントが表示される', async ({ page }) => {
    const searchBox = page.locator('input[aria-label="OCRテキストを検索"]');
    await searchBox.fill('OCR');
    // 「検索フィルタ中は並び替えできません」ヒント
    await expect(page.locator('.search-filter-hint')).toBeVisible();
  });
});
