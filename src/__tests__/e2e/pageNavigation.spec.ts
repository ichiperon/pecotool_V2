import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: ページナビゲーション確認
 * - サムネイルクリックでページ切替
 * - ステータスバーのページ数表示
 * - キーボード矢印キーによるページ移動
 */
test.describe('PageNavigation: サムネイルとページ移動', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
    await loadFixtureDocument(page);
  });

  test('[PN-01] ステータスバーのページ入力に "1" が表示され "/" 区切りで "2" が表示される', async ({ page }) => {
    // status-bar はページ番号 input + "/ N" スパンの構成。
    // input value は textContent に含まれないため page-input と "/" スパンで個別に確認する。
    await expect(page.locator('.page-input')).toHaveValue('1');
    await expect(page.locator('.status-center span[aria-hidden]')).toContainText('/ 2');
  });

  test('[PN-02] サムネイルパネルに 2 件のサムネイルが存在する', async ({ page }) => {
    await expect(page.locator('.thumbnails-panel .thumbnail-item')).toHaveCount(2);
  });

  test('[PN-03] 2 枚目サムネイルをクリックすると 2 ページ目に移動する', async ({ page }) => {
    const thumbs = page.locator('.thumbnails-panel .thumbnail-item');
    await thumbs.nth(1).click();

    await expect(page.locator('.page-input')).toHaveValue('2');

    const currentPage = await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      return usePecoStore.getState().currentPageIndex;
    });
    expect(currentPage).toBe(1);
  });

  test('[PN-04] 矢印キー ↓ でページが 2 ページ目に移動する', async ({ page }) => {
    const scrollContent = page.locator('.thumbnails-panel .scroll-content');
    await scrollContent.focus();
    await page.keyboard.press('ArrowDown');

    await expect(page.locator('.page-input')).toHaveValue('2');

    const currentPage = await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      return usePecoStore.getState().currentPageIndex;
    });
    expect(currentPage).toBe(1);
  });

  test('[PN-05] 2 ページ目から矢印キー ↑ で 1 ページ目に戻る', async ({ page }) => {
    // まず 2 ページ目に移動
    const thumbs = page.locator('.thumbnails-panel .thumbnail-item');
    await thumbs.nth(1).click();
    await expect(page.locator('.page-input')).toHaveValue('2');

    // ↑ で戻る
    const scrollContent = page.locator('.thumbnails-panel .scroll-content');
    await scrollContent.focus();
    await page.keyboard.press('ArrowUp');

    await expect(page.locator('.page-input')).toHaveValue('1');
  });
});
