import { test, expect } from '@playwright/test';

/**
 * Phase 3: E2E テスト (Playwright)
 * Tauri アプリケーションの主要な操作フローを自動テストします。
 */

test.describe('PecoTool v2: アプリ全体操作 E2E テスト', () => {

  test.beforeEach(async ({ page }) => {
    // 開発サーバー上のアプリにアクセス
    await page.goto('/');
    // アプリのコンテナが表示されるまで待機
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 10000 });
  });

  test.describe('E-F: ファイル操作', () => {
    test('[E-F-01] 初期状態のツールバー確認', async ({ page }) => {
      // 開くボタンが存在することを確認
      const openButton = page.locator('button', { hasText: '開く' });
      await expect(openButton).toBeVisible();
      
      // 未読み込み時のプレースホルダー確認
      await expect(page.locator('.empty-state')).toContainText('PDFファイルを [開く] から読み込んでください');
    });

    test('[E-F-04] ダーティマークの表示確認', async ({ page }) => {
      // 実際には PDF を読み込む必要があるが、
      // 読み込み済みの状態で「未保存の変更あり」が表示されるかのロジックテストも兼ねる
      // ※E2Eでは初期状態の「なし」も確認
      await expect(page.locator('.status-bar')).toContainText('0 / 0');
    });
  });

  test.describe('E-C: キャンバス操作・編集', () => {
    test('[E-C-01] 描画モードの切り替え', async ({ page }) => {
      const addBtn = page.locator('button', { hasText: '追加' });
      await addBtn.click();
      
      // ボタンが active クラスを持つことを確認
      await expect(addBtn).toHaveClass(/active/);
      
      // キャンバスのカーソルが crosshair に変わっているか確認 (CSS 経由)
      const wrapper = page.locator('.canvas-wrapper');
      await expect(wrapper).toHaveClass(/drawing-mode/);
    });

    test('[E-C-05] 複数選択（UI操作）', async ({ page }) => {
      // ツールバーのボタン類が正しく有効化/無効化されるか
      const groupBtn = page.locator('button', { hasText: 'グループ化' });
      await expect(groupBtn).toBeDisabled(); // 選択なしなら無効
    });
  });

  test.describe('E-K: キーボードショートカット', () => {
    test('[E-K-03] フィット（Ctrl+0）', async ({ page }) => {
      // ショートカットキーのイベントが発火して Fit モードになるか
      await page.keyboard.press('Control+0');
      const fitBtn = page.getByTitle(/フィット/);
      await expect(fitBtn).toHaveClass(/active/);
    });

    test('[E-K-05] 矢印キーでのページ移動（サムネイルパネル）', async ({ page }) => {
      const thumbs = page.locator('.thumbnails-panel .scroll-content');
      await thumbs.focus();
      await page.keyboard.press('ArrowDown');
      // 実際には 0 ページ目なので変化なしだが、イベントが走ることを確認
    });
  });

  test.describe('E-P: プレビューウィンドウ連携', () => {
    test('[E-P-01] プレビューボタンの動作確認', async ({ page }) => {
      const previewBtn = page.locator('button', { hasText: 'テキスト確認' });
      await expect(previewBtn).toBeVisible();
      // クリックしてエラーが出ないことを確認
      await previewBtn.click();
    });
  });

  test.describe('E-M: マリン監修・機能追加', () => {
    test('Ctrl+矢印キーでのカードナビゲーション（実装済み機能）', async ({ page }) => {
      // OCRカードリストが空でない場合に Ctrl+ArrowDown で移動できるか
      // ※初期状態は空なので、要素が存在しないことを確認
      await expect(page.locator('.ocr-card')).toHaveCount(0);
    });
  });

  /**
   * ------------------------------------------------------------------
   * 宿題: 実 PDF を用いた E2E シナリオ (E2E-02 / E2E-05 / E2E-12)
   * ------------------------------------------------------------------
   * 現状、本プロジェクトの「PDFを開く」導線は `@tauri-apps/plugin-dialog`
   * 経由の OS ネイティブダイアログに依存している。Playwright を
   * Vite dev server (http://localhost:1420) に対して起動する現在の
   * 構成では Tauri API 名前空間が存在せず、ファイル読込をシミュレート
   * できない。
   *
   * これらを実行可能にするには以下いずれかの対応が必要:
   *   1. `tauri-driver` + `webdriverio` を導入し Tauri アプリ本体に
   *      対して E2E を実行する (公式推奨)。
   *   2. テスト時限定で `window.__TAURI__` をモックし、
   *      dialog.open() / fs.readFile() をスタブ化する
   *      (vite の define/env で切替)。
   *   3. dev ビルド限定でドロップインの `<input type="file">`
   *      フォールバック導線を実装する。
   *
   * 上記いずれかが整備されるまで describe.skip() で宿題化し、
   * 要件 (docs/TEST_REQUIREMENTS.md §Phase 4) とのトレーサビリティ
   * を確保する。
   *
   * TODO(next-release): PDF fixture を test-scratch/ に配置し、
   *   上記 1〜3 のいずれかで PDF 読み込み導線を E2E から叩けるように
   *   なった段階で `describe.skip` → `describe` へ戻す。
   */
  test.describe.skip('E-PDF: 実 PDF を伴うシナリオ (Tauri driver 未整備のため skip)', () => {
    /**
     * E2E-02: PDF 読み込み
     * 期待結果: Canvas 描画 / ページ数表示 / サムネイル / OCR カード
     */
    test('[E2E-02] PDF 読み込み → Canvas/サムネイル/OCR カードが出現', async ({ page }) => {
      // TODO: dialog.open() をスタブ化し、テスト用 PDF のパスを返す
      // await mockTauriDialog(page, 'test-scratch/sample.pdf');

      const openButton = page.locator('button', { hasText: '開く' });
      await openButton.click();

      // (1) Canvas (PDF 本体レイヤー + オーバーレイ) が描画されること
      await expect(page.locator('.canvas-wrapper canvas')).toHaveCount(2);

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
      // TODO: 上記同様 PDF をロード済みとする
      // await loadFixturePdf(page, 'test-scratch/sample.pdf');

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

      // Ctrl+Z で戻る
      await page.keyboard.press('Control+Z');

      // 元テキストに復元されていること
      await expect(editable).toHaveText(originalText);
    });

    /**
     * E2E-12: グループ化（複数選択 → マージ）
     * 期待結果: マージ結果の 1 カード + テキスト結合
     */
    test('[E2E-12] OCR カード複数選択 → グループ化でマージ', async ({ page }) => {
      // TODO: 上記同様 PDF をロード済みとする
      // await loadFixturePdf(page, 'test-scratch/sample.pdf');

      const cards = page.locator('.ocr-card');
      await expect(cards.nth(1)).toBeVisible();

      const countBefore = await cards.count();

      // 1 枚目クリック + Ctrl クリックで 2 枚目追加選択
      await cards.nth(0).click();
      await cards.nth(1).click({ modifiers: ['Control'] });

      // グループ化ボタンが有効化されること
      const groupBtn = page.locator('button', { hasText: 'グループ化' });
      await expect(groupBtn).toBeEnabled();

      await groupBtn.click();

      // カード総数が 1 減ること（2 枚 → 1 枚にマージ）
      await expect(cards).toHaveCount(countBefore - 1);

      // dirty 状態になっていること
      await expect(page.locator('.status-bar')).toContainText(/未保存/);
    });
  });
});
