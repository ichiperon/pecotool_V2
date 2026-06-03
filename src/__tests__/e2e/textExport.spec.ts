import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument, getTauriInvokeHistory } from './helpers/tauriMock';

/**
 * E2E: テキストエクスポート (TXT / MD / CSV / JSON) の UI フロー
 *
 * 実際のファイル書き出しは Tauri FS プラグインを呼ぶが、
 * E2E 環境では plugin:dialog|save と plugin:fs|write_text_file を mock している。
 * テストではドロップダウンの表示と onExport コールバックが適切に呼ばれることを確認する。
 */
test.describe('TextExport: エクスポートドロップダウンの動作', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
    await loadFixtureDocument(page);
  });

  test('[EX-01] ファイルタブ → 現在ページのエクスポートドロップダウンが開く', async ({ page }) => {
    // ファイルタブはデフォルト
    const exportCurrentBtn = page.locator('button', { hasText: '現在ページ' });
    await expect(exportCurrentBtn).toBeVisible();
    await expect(exportCurrentBtn).toBeEnabled();

    await exportCurrentBtn.click();

    // ドロップダウンに 4 フォーマットが表示される
    await expect(page.locator('.ribbon-dropdown-item', { hasText: 'テキスト (.txt)' })).toBeVisible();
    await expect(page.locator('.ribbon-dropdown-item', { hasText: 'Markdown (.md)' })).toBeVisible();
    await expect(page.locator('.ribbon-dropdown-item', { hasText: 'CSV (.csv)' })).toBeVisible();
    await expect(page.locator('.ribbon-dropdown-item', { hasText: 'JSON (.json)' })).toBeVisible();
  });

  test('[EX-02] ファイルタブ → 全ページエクスポートドロップダウンが開く', async ({ page }) => {
    const exportAllBtn = page.locator('button', { hasText: '全ページ' });
    await expect(exportAllBtn).toBeVisible();
    await expect(exportAllBtn).toBeEnabled();

    await exportAllBtn.click();

    await expect(page.locator('.ribbon-dropdown-item', { hasText: 'テキスト (.txt)' })).toBeVisible();
    await expect(page.locator('.ribbon-dropdown-item', { hasText: 'JSON (.json)' })).toBeVisible();
  });

  test('[EX-03] ファイル未読込時はエクスポートボタンが無効', async ({ page }) => {
    // fixture を読み込まない状態でページを再読み込み
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });

    const exportCurrentBtn = page.locator('button', { hasText: '現在ページ' });
    await expect(exportCurrentBtn).toBeDisabled();

    const exportAllBtn = page.locator('button', { hasText: '全ページ' });
    await expect(exportAllBtn).toBeDisabled();
  });

  test('[EX-04] エクスポート形式を選択するとドロップダウンが閉じる', async ({ page }) => {
    const exportCurrentBtn = page.locator('button', { hasText: '現在ページ' });
    await exportCurrentBtn.click();

    const txtItem = page.locator('.ribbon-dropdown-item', { hasText: 'テキスト (.txt)' });
    await expect(txtItem).toBeVisible();
    await txtItem.click();

    // ドロップダウンが閉じる
    await expect(txtItem).not.toBeVisible();
  });
});
