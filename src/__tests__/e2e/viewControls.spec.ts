import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: 表示コントロール全般
 * - Ctrl+0 でフィット
 * - プレビューウィンドウ連携
 * - 初期状態の empty-state 表示
 */
test.describe('ViewControls: フィット・プレビュー・初期状態', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
  });

  test('[VC-01] ファイル未読込時に empty-state が表示される', async ({ page }) => {
    await expect(page.locator('.empty-state')).toContainText('PDFファイルを [開く] から読み込んでください');
  });

  test('[VC-02] Ctrl+0 でフィットモードが有効になる', async ({ page }) => {
    await loadFixtureDocument(page);
    await page.keyboard.press('Control+0');

    await page.locator('[role="tablist"] button', { hasText: '表示' }).click();
    await expect(page.locator('button', { hasText: 'フィット' })).toHaveClass(/active/);
  });

  test('[VC-03] プレビューボタンをクリックすると Tauri ウィンドウ API が呼ばれる', async ({ page }) => {
    await loadFixtureDocument(page);

    // 表示タブを開いてプレビューボタンをクリック
    await page.locator('[role="tablist"] button', { hasText: '表示' }).click();
    const previewBtn = page.locator('button', { hasText: 'テキスト確認' });
    await expect(previewBtn).toBeEnabled();
    await previewBtn.click();

    await expect.poll(async () => {
      const history = await page.evaluate(
        () => (window as any).__TAURI_INVOKE_HISTORY__ ?? [],
      );
      return history.map((h: any) => h.cmd);
    }).toContain('plugin:window|get_all_windows');
  });

  test('[VC-04] ファイル読込後はステータスバーが "1 / N" 形式になる', async ({ page }) => {
    await loadFixtureDocument(page);
    await expect(page.locator('.status-bar')).toContainText(/\d+\s*\/\s*\d+/);
  });

  test('[VC-05] canvas が 3 レイヤー構成で描画される', async ({ page }) => {
    await loadFixtureDocument(page);
    // PDF 本体 + 静的オーバーレイ + 動的オーバーレイ = 3 枚
    await expect(page.locator('.canvas-wrapper canvas')).toHaveCount(3);
  });
});
