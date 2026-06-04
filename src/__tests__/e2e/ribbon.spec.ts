import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: Ribbon タブ切替と各タブのコンテンツ表示確認
 */
test.describe('Ribbon: タブ切替と各タブのボタン表示', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
  });

  test('[R-01] ファイルタブが初期表示される', async ({ page }) => {
    // ファイルタブはデフォルトで active
    const fileTab = page.locator('[role="tablist"] button', { hasText: 'ファイル' });
    await expect(fileTab).toBeVisible();
    await expect(fileTab).toHaveClass(/active/);

    // ファイルタブ配下のボタンが見える
    await expect(page.locator('button', { hasText: '開く' }).first()).toBeVisible();
    await expect(page.locator('button', { hasText: '保存' }).first()).toBeVisible();
  });

  test('[R-02] 編集タブに切り替えると編集系ボタンが表示される', async ({ page }) => {
    await loadFixtureDocument(page);

    const editTab = page.locator('[role="tablist"] button', { hasText: '編集' });
    await editTab.click();
    await expect(editTab).toHaveClass(/active/);

    // 編集タブのボタン群が存在すること
    await expect(page.locator('button', { hasText: 'Undo' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Redo' })).toBeVisible();
    await expect(page.locator('button', { hasText: '全選択' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'グループ化' })).toBeVisible();
  });

  test('[R-03] OCR タブに切り替えると OCR 実行ボタンが表示される', async ({ page }) => {
    const ocrTab = page.locator('[role="tablist"] button', { hasText: 'OCR' });
    await ocrTab.click();
    await expect(ocrTab).toHaveClass(/active/);

    await expect(page.locator('button', { hasText: 'OCR実行' })).toBeVisible();
    await expect(page.locator('button', { hasText: '範囲指定' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'OCR消去' })).toBeVisible();
  });

  test('[R-04] 表示タブに切り替えるとズームボタンとスライダーが表示される', async ({ page }) => {
    const viewTab = page.locator('[role="tablist"] button', { hasText: '表示' });
    await viewTab.click();
    await expect(viewTab).toHaveClass(/active/);

    await expect(page.locator('button', { hasText: '拡大' })).toBeVisible();
    await expect(page.locator('button', { hasText: '縮小' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'フィット' })).toBeVisible();
    // OCR オーバーレイスライダーが存在すること
    await expect(page.locator('input.ocr-opacity-slider').first()).toBeVisible();
  });

  test('[R-05] ヘルプタブに切り替えるとヘルプ系ボタンが表示される', async ({ page }) => {
    const helpTab = page.locator('[role="tablist"] button', { hasText: 'ヘルプ' });
    await helpTab.click();
    await expect(helpTab).toHaveClass(/active/);

    await expect(page.locator('button', { hasText: 'ショートカット' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'ツールの使い方' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'バージョン情報' })).toBeVisible();
  });

  test('[R-06] Alt+O キーで OCR タブに切り替わる', async ({ page }) => {
    // 初期はファイルタブ
    const ocrTab = page.locator('[role="tablist"] button', { hasText: 'OCR' });
    await expect(ocrTab).not.toHaveClass(/active/);

    await page.keyboard.press('Alt+o');
    await expect(ocrTab).toHaveClass(/active/);
    await expect(page.locator('button', { hasText: 'OCR実行' })).toBeVisible();
  });

  test('[R-07] Alt+H キーでヘルプタブに切り替わる', async ({ page }) => {
    const helpTab = page.locator('[role="tablist"] button', { hasText: 'ヘルプ' });
    await page.keyboard.press('Alt+h');
    await expect(helpTab).toHaveClass(/active/);
  });
});
