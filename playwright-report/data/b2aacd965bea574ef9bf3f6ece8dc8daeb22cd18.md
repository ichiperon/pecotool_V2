# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pecotool.spec.ts >> PecoTool v2: アプリ全体操作 E2E テスト >> E-C: キャンバス操作・編集 >> [E-C-01] 描画モードの切り替え
- Location: src\__tests__\e2e\pecotool.spec.ts:36:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.app-container')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('.app-container')

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | /**
  4  |  * Phase 3: E2E テスト (Playwright)
  5  |  * Tauri アプリケーションの主要な操作フローを自動テストします。
  6  |  */
  7  | 
  8  | test.describe('PecoTool v2: アプリ全体操作 E2E テスト', () => {
  9  | 
  10 |   test.beforeEach(async ({ page }) => {
  11 |     // 開発サーバー上のアプリにアクセス
  12 |     await page.goto('/');
  13 |     // アプリのコンテナが表示されるまで待機
> 14 |     await expect(page.locator('.app-container')).toBeVisible({ timeout: 10000 });
     |                                                  ^ Error: expect(locator).toBeVisible() failed
  15 |   });
  16 | 
  17 |   test.describe('E-F: ファイル操作', () => {
  18 |     test('[E-F-01] 初期状態のツールバー確認', async ({ page }) => {
  19 |       // 開くボタンが存在することを確認
  20 |       const openButton = page.locator('button', { hasText: '開く' });
  21 |       await expect(openButton).toBeVisible();
  22 |       
  23 |       // 未読み込み時のプレースホルダー確認
  24 |       await expect(page.locator('.empty-state')).toContainText('PDFファイルを [開く] から読み込んでください');
  25 |     });
  26 | 
  27 |     test('[E-F-04] ダーティマークの表示確認', async ({ page }) => {
  28 |       // 実際には PDF を読み込む必要があるが、
  29 |       // 読み込み済みの状態で「未保存の変更あり」が表示されるかのロジックテストも兼ねる
  30 |       // ※E2Eでは初期状態の「なし」も確認
  31 |       await expect(page.locator('.status-bar')).toContainText('0 / 0');
  32 |     });
  33 |   });
  34 | 
  35 |   test.describe('E-C: キャンバス操作・編集', () => {
  36 |     test('[E-C-01] 描画モードの切り替え', async ({ page }) => {
  37 |       const addBtn = page.locator('button', { hasText: '追加' });
  38 |       await addBtn.click();
  39 |       
  40 |       // ボタンが active クラスを持つことを確認
  41 |       await expect(addBtn).toHaveClass(/active/);
  42 |       
  43 |       // キャンバスのカーソルが crosshair に変わっているか確認 (CSS 経由)
  44 |       const wrapper = page.locator('.canvas-wrapper');
  45 |       await expect(wrapper).toHaveClass(/drawing-mode/);
  46 |     });
  47 | 
  48 |     test('[E-C-05] 複数選択（UI操作）', async ({ page }) => {
  49 |       // ツールバーのボタン類が正しく有効化/無効化されるか
  50 |       const groupBtn = page.locator('button', { hasText: 'グループ化' });
  51 |       await expect(groupBtn).toBeDisabled(); // 選択なしなら無効
  52 |     });
  53 |   });
  54 | 
  55 |   test.describe('E-K: キーボードショートカット', () => {
  56 |     test('[E-K-03] フィット（Ctrl+0）', async ({ page }) => {
  57 |       // ショートカットキーのイベントが発火して Fit モードになるか
  58 |       await page.keyboard.press('Control+0');
  59 |       const fitBtn = page.getByTitle(/フィット/);
  60 |       await expect(fitBtn).toHaveClass(/active/);
  61 |     });
  62 | 
  63 |     test('[E-K-05] 矢印キーでのページ移動（サムネイルパネル）', async ({ page }) => {
  64 |       const thumbs = page.locator('.thumbnails-panel .scroll-content');
  65 |       await thumbs.focus();
  66 |       await page.keyboard.press('ArrowDown');
  67 |       // 実際には 0 ページ目なので変化なしだが、イベントが走ることを確認
  68 |     });
  69 |   });
  70 | 
  71 |   test.describe('E-P: プレビューウィンドウ連携', () => {
  72 |     test('[E-P-01] プレビューボタンの動作確認', async ({ page }) => {
  73 |       const previewBtn = page.locator('button', { hasText: '別ウインドウで確認' });
  74 |       await expect(previewBtn).toBeVisible();
  75 |       // クリックしてエラーが出ないことを確認
  76 |       await previewBtn.click();
  77 |     });
  78 |   });
  79 | 
  80 |   test.describe('E-M: マリン監修・機能追加', () => {
  81 |     test('Ctrl+矢印キーでのカードナビゲーション（実装済み機能）', async ({ page }) => {
  82 |       // OCRカードリストが空でない場合に Ctrl+ArrowDown で移動できるか
  83 |       // ※初期状態は空なので、要素が存在しないことを確認
  84 |       await expect(page.locator('.ocr-card')).toHaveCount(0);
  85 |     });
  86 |   });
  87 | });
  88 | 
```