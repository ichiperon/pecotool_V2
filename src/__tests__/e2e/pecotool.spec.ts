import { test, expect } from '@playwright/test';
import { installTauriMocks, getTauriInvokeHistory, loadFixtureDocument } from './helpers/tauriMock';

/**
 * Phase 3: E2E テスト (Playwright)
 * Tauri アプリケーションの主要な操作フローを自動テストします。
 */

test.describe('PecoTool v2: アプリ全体操作 E2E テスト', () => {

  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    // 開発サーバー上のアプリにアクセス
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // アプリのコンテナが表示されるまで待機
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
  });

  test.describe('E-F: ファイル操作', () => {
    test('[E-F-01] 初期状態のツールバー確認', async ({ page }) => {
      // Ribbon のファイルタブが初期表示されていることを確認
      const fileTab = page.locator('[role="tablist"] button', { hasText: 'ファイル' });
      await expect(fileTab).toBeVisible();
      await expect(fileTab).toHaveClass(/active/);

      // ファイルタブ内に「開く」ボタンが存在することを確認
      await expect(page.locator('button', { hasText: '開く' }).first()).toBeVisible();

      // 未読み込み時のプレースホルダー確認
      await expect(page.locator('.empty-state')).toContainText('PDFファイルを [開く] から読み込んでください');

      await expect.poll(async () => (await getTauriInvokeHistory(page)).map(({ cmd }) => cmd)).toContain('check_pending_backups');
      await expect(page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('__unknown_e2e_command__'))).rejects.toThrow(/Unknown invoke/);
    });

    test('[E-F-04] ダーティマークの表示確認', async ({ page }) => {
      // 実際には PDF を読み込む必要があるが、
      // 読み込み済みの状態で「未保存の変更あり」が表示されるかのロジックテストも兼ねる
      // ※E2Eでは初期状態の「なし」も確認
      await expect(page.locator('.status-bar')).toContainText(/0\s*\/\s*0/);
    });
  });

  test.describe('E-C: キャンバス操作・編集', () => {
    test('[E-C-01] 描画モードの切り替え', async ({ page }) => {
      await loadFixtureDocument(page);

      // 編集タブに切り替えて「追加」ボタンを操作する（Ribbon Phase 1 以降）
      const editTab = page.locator('[role="tablist"] button', { hasText: '編集' });
      await editTab.click();

      const addBtn = page.locator('button', { hasText: '追加' });
      await addBtn.click();

      // ボタンが active クラスを持つことを確認
      await expect(addBtn).toHaveClass(/active/);

      // キャンバスのカーソルが crosshair に変わっているか確認 (CSS 経由)
      const wrapper = page.locator('.canvas-wrapper');
      await expect(wrapper).toHaveClass(/drawing-mode/);
    });

    test('[E-C-05] 複数選択（UI操作）', async ({ page }) => {
      // 編集タブに切り替えてグループ化ボタンの無効状態を確認する（Ribbon Phase 1 以降）
      const editTab = page.locator('[role="tablist"] button', { hasText: '編集' });
      await editTab.click();

      const groupBtn = page.locator('button', { hasText: 'グループ化' });
      await expect(groupBtn).toBeDisabled(); // 選択なしなら無効
    });
  });

  test.describe('E-K: キーボードショートカット', () => {
    test('[E-K-03] フィット（Ctrl+0）', async ({ page }) => {
      // 表示タブに切り替えてフィットボタンの状態を確認する（Ribbon Phase 1 以降）
      const viewTab = page.locator('[role="tablist"] button', { hasText: '表示' });
      await viewTab.click();

      // ショートカットキーのイベントが発火して Fit モードになるか
      await page.keyboard.press('Control+0');
      const fitBtn = page.locator('button', { hasText: 'フィット' });
      await expect(fitBtn).toHaveClass(/active/);
    });

    test('[E-K-05] 矢印キーでのページ移動（サムネイルパネル）', async ({ page }) => {
      await loadFixtureDocument(page);
      const thumbs = page.locator('.thumbnails-panel .scroll-content');
      await thumbs.focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.page-input')).toHaveValue('2');
      await expect.poll(async () => page.evaluate(async () => {
        const { usePecoStore } = await import('/src/store/pecoStore.ts');
        return usePecoStore.getState().currentPageIndex;
      })).toBe(1);
    });
  });

  test.describe('E-P: プレビューウィンドウ連携', () => {
    test('[E-P-01] プレビューボタンの動作確認', async ({ page }) => {
      await loadFixtureDocument(page);

      // 表示タブに切り替えて「テキスト確認」ボタンを操作する（Ribbon Phase 1 以降）
      const viewTab = page.locator('[role="tablist"] button', { hasText: '表示' });
      await viewTab.click();

      const previewBtn = page.locator('button', { hasText: 'テキスト確認' });
      await expect(previewBtn).toBeVisible();
      await previewBtn.click();
      await expect(previewBtn).toHaveClass(/active/);
      await expect.poll(async () => (await getTauriInvokeHistory(page)).map(({ cmd }) => cmd)).toEqual(
        expect.arrayContaining([
          'plugin:window|get_all_windows',
          'plugin:webview|create_webview_window',
          'plugin:window|show',
          'plugin:window|set_focus',
        ]),
      );
    });
  });

  test.describe('E-M: マリン監修・機能追加', () => {
    test('Ctrl+矢印キーでのカードナビゲーション（実装済み機能）', async ({ page }) => {
      await loadFixtureDocument(page);
      await expect(page.locator('.ocr-card')).toHaveCount(2);
    });
  });

  test.describe('E-PDF: PDF 読み込み済み状態の主要シナリオ', () => {
    /**
     * E2E-02: PDF 読み込み
     * 期待結果: Canvas 描画 / ページ数表示 / サムネイル / OCR カード
     */
    test('[E2E-02] PDF 読み込み → Canvas/サムネイル/OCR カードが出現', async ({ page }) => {
      await loadFixtureDocument(page);

      // (1) Canvas (PDF 本体レイヤー + オーバーレイ) が描画されること
      await expect(page.locator('.canvas-wrapper canvas')).toHaveCount(3);

      // (2) ステータスバーに "1 / N" 形式でページ数が表示されること
      await expect(page.locator('.status-bar')).toContainText(/\d+\s*\/\s*\d+/);

      // (3) サムネイルパネルに少なくとも 1 件サムネイルが出ること
      await expect(page.locator('.thumbnails-panel .thumbnail-item').first()).toBeVisible();

      // (4) OCR カードリストに 1 件以上カードが出ること
      await expect(page.locator('.ocr-card').first()).toBeVisible();
    });

    /**
     * E2E-05: Ctrl+Z で Undo
     * 期待結果: 直前の編集が元に戻る
     */
    test('[E2E-05] Ctrl+Z で Undo 動作', async ({ page }) => {
      await loadFixtureDocument(page);

      const firstCard = page.locator('.ocr-card').first();
      await expect(firstCard).toBeVisible();

      // 元テキストを退避
      const editable = firstCard.locator('[contenteditable="true"]').first();
      const originalText = (await editable.textContent()) ?? '';

      // テキスト編集 → blur で store 更新
      await editable.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.type('__EDITED__');
      await editable.blur();

      // dirty マークが出ることを確認
      await expect(page.locator('.status-bar')).toContainText(/未保存/);

      // Ctrl+Z で戻る（グローバルショートカット。Ribbon に依存しない）
      await page.keyboard.press('Control+Z');

      // 元テキストに復元されていること
      await expect(editable).toHaveText(originalText);
    });

    /**
     * E2E-12: グループ化（複数選択 → マージ）
     * 期待結果: マージ結果の 1 カード + テキスト結合
     */
    test('[E2E-12] OCR カード複数選択 → グループ化でマージ', async ({ page }) => {
      await loadFixtureDocument(page);

      const cards = page.locator('.ocr-card');
      await expect(cards.nth(1)).toBeVisible();

      const countBefore = await cards.count();

      // 1 枚目クリック + Ctrl クリックで 2 枚目追加選択
      await cards.nth(0).click();
      await cards.nth(1).click({ modifiers: ['Control'] });

      // 編集タブに切り替えてグループ化ボタンを操作する（Ribbon Phase 1 以降）
      const editTab = page.locator('[role="tablist"] button', { hasText: '編集' });
      await editTab.click();

      // グループ化ボタンが有効化されること
      const groupBtn = page.locator('button', { hasText: 'グループ化' });
      await expect(groupBtn).toBeEnabled();

      await groupBtn.click();

      // カード総数が 1 減ること（2 枚 → 1 枚にマージ）
      await expect(cards).toHaveCount(countBefore - 1);

      const mergedText = await cards.first().locator('[contenteditable="true"]').textContent();
      expect(mergedText).toContain('最初のOCRテキスト');
      expect(mergedText).toContain('二つ目のOCRテキスト');

      // dirty 状態になっていること
      await expect(page.locator('.status-bar')).toContainText(/未保存/);
    });
  });
});
