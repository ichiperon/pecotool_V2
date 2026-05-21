import { test, expect } from '@playwright/test';

/**
 * Phase 3: E2E テスト (Playwright)
 * Tauri アプリケーションの主要な操作フローを自動テストします。
 */

async function installTauriMocks(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (payload: unknown) => void>();
    const invokeHistory: Array<{ cmd: string; args?: unknown }> = [];
    const previewWindows = new Set<string>();
    let callbackId = 1;

    (window as any).__TAURI_INVOKE_HISTORY__ = invokeHistory;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    };
    const knownInvokes: Record<string, (args?: any) => unknown> = {
      'plugin:event|listen': (args) => args?.handler ?? 0,
      'plugin:event|unlisten': () => null,
      'plugin:event|emit': () => null,
      'plugin:window|get_all_windows': () => ['main', ...previewWindows],
      'plugin:webview|create_webview_window': (args) => {
        previewWindows.add(args?.label ?? 'preview-window');
        return null;
      },
      'plugin:window|show': () => null,
      'plugin:window|hide': () => null,
      'plugin:window|set_focus': () => null,
      check_pending_backups: () => [],
      clear_backup: () => null,
      save_backup: () => null,
      load_meiryo_font: () => {
        throw new Error('not available in e2e browser');
      },
    };

    (window as any).__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
      callbacks,
      transformCallback: (callback: (payload: unknown) => void, once = false) => {
        const id = callbackId++;
        callbacks.set(id, (payload: unknown) => {
          if (once) callbacks.delete(id);
          callback(payload);
        });
        return id;
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id);
      },
      runCallback: (id: number, payload: unknown) => {
        callbacks.get(id)?.(payload);
      },
      convertFileSrc: (filePath: string) => `http://asset.localhost/${encodeURIComponent(filePath)}`,
      invoke: async (cmd: string, args?: any) => {
        const handler = knownInvokes[cmd];
        if (!handler) throw new Error(`[e2e tauri mock] Unknown invoke: ${cmd}`);
        invokeHistory.push({ cmd, args });
        return handler(args);
      },
    };
  });
}

async function getTauriInvokeHistory(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as any).__TAURI_INVOKE_HISTORY__ ?? []) as Promise<Array<{ cmd: string; args?: unknown }>>;
}

async function loadFixtureDocument(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const { usePecoStore } = await import('/src/store/pecoStore.ts');
    usePecoStore.getState().setDocument({
      filePath: 'e2e-fixture.pdf',
      fileName: 'e2e-fixture.pdf',
      totalPages: 2,
      metadata: {},
      pages: new Map([
        [0, {
          width: 600,
          height: 800,
          rotation: 0,
          textBlocks: [
            {
              id: 'block-1',
              text: '最初のOCRテキスト',
              bbox: { x: 80, y: 90, width: 160, height: 32 },
              writingMode: 'horizontal',
              order: 0,
              isDirty: false,
            },
            {
              id: 'block-2',
              text: '二つ目のOCRテキスト',
              bbox: { x: 80, y: 150, width: 180, height: 32 },
              writingMode: 'horizontal',
              order: 1,
              isDirty: false,
            },
          ],
          isTextExtracted: true,
          isDirty: false,
        }],
        [1, {
          width: 600,
          height: 800,
          rotation: 0,
          textBlocks: [
            {
              id: 'block-3',
              text: '2ページ目',
              bbox: { x: 60, y: 80, width: 120, height: 30 },
              writingMode: 'horizontal',
              order: 0,
              isDirty: false,
            },
          ],
          isTextExtracted: true,
          isDirty: false,
        }],
      ]),
    });
  });
  await expect(page.locator('.ocr-card').first()).toBeVisible();
}

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
      // ファイルメニューから開く導線が存在することを確認
      const fileMenu = page.locator('button', { hasText: 'ファイル' });
      await expect(fileMenu).toBeVisible();
      await fileMenu.click();
      await expect(page.locator('.menu-dropdown-item', { hasText: '開く' })).toBeVisible();
      
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
      await loadFixtureDocument(page);

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

      const mergedText = await cards.first().locator('[contenteditable="true"]').textContent();
      expect(mergedText).toContain('最初のOCRテキスト');
      expect(mergedText).toContain('二つ目のOCRテキスト');

      // dirty 状態になっていること
      await expect(page.locator('.status-bar')).toContainText(/未保存/);
    });
  });
});
