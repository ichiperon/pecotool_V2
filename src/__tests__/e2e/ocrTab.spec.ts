import { test, expect } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * E2E: OCR タブの操作確認
 * - OCR 実行ドロップダウンの展開
 * - ファイル未読込時のボタン無効化
 * - 消去ドロップダウンの動作
 */
test.describe('OcrTab: OCR 実行・消去ドロップダウン', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
  });

  test('[OT-01] ファイル未読込時は範囲指定・OCR消去ボタンが無効', async ({ page }) => {
    await page.locator('[role="tablist"] button', { hasText: 'OCR' }).click();

    // 範囲指定は isFileLoaded が false なら disabled
    await expect(page.locator('button', { hasText: '範囲指定' })).toBeDisabled();
    // OCR消去は isFileLoaded が false なら disabled
    await expect(page.locator('button', { hasText: 'OCR消去' })).toBeDisabled();
  });

  test('[OT-02] ファイル読込後に OCR 実行ドロップダウンが展開できる', async ({ page }) => {
    await loadFixtureDocument(page);
    await page.locator('[role="tablist"] button', { hasText: 'OCR' }).click();

    const ocrBtn = page.locator('button', { hasText: 'OCR実行' });
    await expect(ocrBtn).toBeEnabled();
    await ocrBtn.click();

    // ドロップダウンのサブメニュー
    await expect(page.locator('.ribbon-dropdown-item', { hasText: '現在のページ' })).toBeVisible();
    await expect(page.locator('.ribbon-dropdown-item', { hasText: '全ページ' })).toBeVisible();
    await expect(page.locator('.ribbon-dropdown-item', { hasText: 'フォルダ内PDF' })).toBeVisible();
  });

  test('[OT-03] ファイル読込後に OCR 消去ドロップダウンが展開できる', async ({ page }) => {
    await loadFixtureDocument(page);
    await page.locator('[role="tablist"] button', { hasText: 'OCR' }).click();

    const clearBtn = page.locator('button', { hasText: 'OCR消去' });
    await expect(clearBtn).toBeEnabled();
    await clearBtn.click();

    await expect(page.locator('.ribbon-dropdown-item', { hasText: '現在のページ' })).toBeVisible();
    await expect(page.locator('.ribbon-dropdown-item', { hasText: '全ページ' })).toBeVisible();
  });

  test('[OT-04] 範囲指定ボタンをクリックすると isRangeOcrMode がトグルされる', async ({ page }) => {
    await loadFixtureDocument(page);
    await page.locator('[role="tablist"] button', { hasText: 'OCR' }).click();

    const rangeBtn = page.locator('button', { hasText: '範囲指定' });
    await rangeBtn.click();
    await expect(rangeBtn).toHaveClass(/active/);

    // もう一度クリックで解除
    await rangeBtn.click();
    await expect(rangeBtn).not.toHaveClass(/active/);
  });

  test('[OT-05] 全ページ OCR クリックはエラーをスローしない (v2.0.8 regression)', async ({ page }) => {
    // Regression guard: v2.0.8 で infraStore 分離後に runOcrAllPages が呼べることを確認する。
    // ask() は tauriMock で false を返すため confirmation dialog でキャンセル扱いになり
    // 実際の OCR 処理は走らないが、クリックからハンドラ呼び出しまでの配線が壊れていないことを検証する。
    await loadFixtureDocument(page);
    await page.locator('[role="tablist"] button', { hasText: 'OCR' }).click();

    const ocrBtn = page.locator('button', { hasText: 'OCR実行' });
    await expect(ocrBtn).toBeEnabled();
    await ocrBtn.click();

    const allPagesBtn = page.locator('.ribbon-dropdown-item', { hasText: '全ページ' });
    await expect(allPagesBtn).toBeVisible();

    // ページコンソールエラーをキャプチャ
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await allPagesBtn.click();

    // クリック後にドロップダウンが閉じる (=ハンドラが呼ばれた証拠)
    await expect(allPagesBtn).not.toBeVisible({ timeout: 3000 });

    // コンソールにエラーが出ていないこと
    expect(errors).toHaveLength(0);
  });
});
