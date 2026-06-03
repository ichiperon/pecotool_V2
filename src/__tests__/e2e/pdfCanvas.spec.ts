import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: PdfCanvas のズーム・OCR オーバーレイ表示切替
 */
test.describe('PdfCanvas: ズーム操作と OCR オーバーレイ', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
    await loadFixtureDocument(page);
  });

  test('[C-01] 表示タブの拡大ボタンでズームが増加する', async ({ page }) => {
    // 表示タブに切り替え
    await page.locator('[role="tablist"] button', { hasText: '表示' }).click();

    // 初期ズーム値を取得
    const zoomBefore = await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      return useViewerStore.getState().zoom;
    });

    // 拡大ボタンをクリック
    await page.locator('button', { hasText: '拡大' }).click();

    const zoomAfter = await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      return useViewerStore.getState().zoom;
    });

    expect(zoomAfter).toBeGreaterThan(zoomBefore);
  });

  test('[C-02] 表示タブの縮小ボタンでズームが減少する', async ({ page }) => {
    await page.locator('[role="tablist"] button', { hasText: '表示' }).click();

    const zoomBefore = await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      return useViewerStore.getState().zoom;
    });

    await page.locator('button', { hasText: '縮小' }).click();

    const zoomAfter = await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      return useViewerStore.getState().zoom;
    });

    expect(zoomAfter).toBeLessThan(zoomBefore);
  });

  test('[C-03] ズームアップ後にフィットボタンをクリックするとフィット状態になる', async ({ page }) => {
    // isAutoFit は App.tsx の useState で管理されており viewerStore には存在しない。
    // ズームアップで autoFit を OFF にしてからフィットで ON に戻ることを確認する。
    await page.locator('[role="tablist"] button', { hasText: '表示' }).click();
    const fitBtn = page.locator('button', { hasText: 'フィット' });

    // ズームアップで autoFit を解除する
    await page.locator('button', { hasText: '拡大' }).click();
    await page.locator('button', { hasText: '拡大' }).click();

    // フィットボタンで autoFit を再有効化
    await fitBtn.click();
    await expect(fitBtn).toHaveClass(/active/);
  });

  test('[C-04] OCR 表示トグルで showOcr が切り替わる', async ({ page }) => {
    await page.locator('[role="tablist"] button', { hasText: '表示' }).click();

    const showBefore = await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      return useViewerStore.getState().showOcr;
    });

    await page.locator('button', { hasText: 'OCR表示' }).click();

    const showAfter = await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      return useViewerStore.getState().showOcr;
    });

    expect(showAfter).toBe(!showBefore);
  });

  test('[C-05] OCR オーバーレイスライダーを操作すると ocrOpacity が変化する', async ({ page }) => {
    await page.locator('[role="tablist"] button', { hasText: '表示' }).click();

    const slider = page.locator('input.ocr-opacity-slider').first();
    await expect(slider).toBeVisible();

    // スライダーを 50% に設定
    await slider.fill('0.5');
    await slider.dispatchEvent('change');

    const opacity = await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      return useViewerStore.getState().ocrOpacity;
    });
    expect(opacity).toBeCloseTo(0.5, 1);
  });
});
