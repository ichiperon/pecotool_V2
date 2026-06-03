import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * Regression: right-click must NOT open HelpMenu outside pdf-canvas-container.
 * Covers the v2.0.8 bug where any right-click anywhere opened HelpMenu.
 */
test.describe('contextMenu regression: HelpMenu scope (v2.0.8 fix)', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
    await loadFixtureDocument(page);
  });

  test('[CM-01] Ribbon を右クリックしても HelpMenu が表示されない', async ({ page }) => {
    const ribbon = page.locator('.ribbon');
    await expect(ribbon).toBeVisible();
    await ribbon.click({ button: 'right' });

    const helpMenu = page.locator('.help-context-menu');
    await expect(helpMenu).not.toBeVisible();
  });

  test('[CM-02] OCR エディタパネルを右クリックしても HelpMenu が表示されない', async ({ page }) => {
    const ocrPanel = page.locator('.ocr-editor-panel, [class*="ocr-editor"]').first();
    if (await ocrPanel.count() === 0) {
      // fallback: right-side panel area
      await page.locator('.main-content').click({ button: 'right', position: { x: 900, y: 300 } });
    } else {
      await ocrPanel.click({ button: 'right' });
    }

    const helpMenu = page.locator('.help-context-menu');
    await expect(helpMenu).not.toBeVisible();
  });

  test('[CM-03] ステータスバーを右クリックしても HelpMenu が表示されない', async ({ page }) => {
    const statusBar = page.locator('.status-bar');
    await expect(statusBar).toBeVisible();
    await statusBar.click({ button: 'right' });

    const helpMenu = page.locator('.help-context-menu');
    await expect(helpMenu).not.toBeVisible();
  });

  test('[CM-04] pdf-canvas-container を右クリックすると HelpMenu が表示される', async ({ page }) => {
    const canvasContainer = page.locator('.pdf-canvas-container');
    await expect(canvasContainer).toBeVisible();
    await canvasContainer.click({ button: 'right' });

    const helpMenu = page.locator('.help-context-menu');
    await expect(helpMenu).toBeVisible();
  });

  test('[CM-05] HelpMenu 表示後に左クリックで閉じられる', async ({ page }) => {
    const canvasContainer = page.locator('.pdf-canvas-container');
    await canvasContainer.click({ button: 'right' });
    await expect(page.locator('.help-context-menu')).toBeVisible();

    // left-click anywhere on app-container closes it
    await page.locator('.app-container').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.help-context-menu')).not.toBeVisible();
  });
});
