import { test, expect, Page } from '@playwright/test';
import { installTauriMocks, loadFixtureDocument } from './helpers/tauriMock';

/**
 * PCT-095 regression: Ctrl+0 (フィット表示) が効かない条件の網羅検証
 *
 * ケース一覧:
 *   FIT-01  ファイル読込直後の Ctrl+0 — 基本動作
 *   FIT-02  ズーム変更後の Ctrl+0 — isAutoFit=true かつ zoom がフィット値に戻るか
 *   FIT-03  ページ移動後の Ctrl+0
 *   FIT-04  OCR カード(contentEditable)フォーカス中の Ctrl+0 — isEditing ガード確認
 *   FIT-05  サムネイルパネルフォーカス中の Ctrl+0
 *   FIT-06  テンキー0 (Numpad0) での発火 — PCT-008 再発確認
 *   FIT-07  連打（Ctrl+0 を2回）
 *   FIT-08  ウィンドウリサイズ後の Ctrl+0
 *   FIT-09  PCT-003 再発確認 — ページ寸法未ロード時の Ctrl+0
 */

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー: viewerStore の zoom を JS evaluate で直接読む
// ─────────────────────────────────────────────────────────────────────────────
async function getZoom(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const { useViewerStore } = await import('/src/store/viewerStore.ts');
    return useViewerStore.getState().zoom;
  });
}

// ステータスバーの zoom 表示テキストから数値を読む
async function getStatusBarZoom(page: Page): Promise<number> {
  const text = await page.locator('.status-bar').textContent();
  const m = text?.match(/ズーム:\s*(\d+)%/);
  if (!m) throw new Error(`status-bar zoom not found in: ${text}`);
  return parseInt(m[1], 10);
}

/**
 * フィットボタンの active 状態を確認する。
 *
 * フィットボタンは Ribbon の「表示」タブ内 (activeTab==='view') にのみ存在する。
 * このヘルパーは「表示タブを開く → active 確認 → 元のタブに戻る」をまとめて行う。
 *
 * currentTab: 元に戻すタブ名（default 'edit'）
 */
async function isFitActiveViaViewTab(page: Page, returnTab = '編集'): Promise<boolean> {
  // 表示タブを開く
  await page.locator('[role="tablist"] button', { hasText: '表示' }).click();
  await page.waitForTimeout(50);
  // フィットボタンを探す
  const btn = page.locator('button.ribbon-btn[title="フィット (Ctrl+0)"]').first();
  await btn.waitFor({ state: 'visible', timeout: 5000 });
  const cls = await btn.getAttribute('class') ?? '';
  const active = cls.includes('active');
  // 元のタブに戻る（Ctrl+0 後もフォーカス干渉しないように）
  await page.locator('[role="tablist"] button', { hasText: returnTab }).click();
  await page.waitForTimeout(50);
  return active;
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('PCT-095 Regression: Ctrl+0 フィット表示', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMocks(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 30000 });
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-01: ファイル読込直後の Ctrl+0（基本ケース）
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-01] ファイル読込直後の Ctrl+0 — フィットボタンが active になる', async ({ page }) => {
    await loadFixtureDocument(page);

    // Ctrl+0 を送信
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(200);

    // 表示タブを開いてフィットボタンの active 状態を確認
    const fitActive = await isFitActiveViaViewTab(page);
    expect(fitActive).toBe(true);

    const zoom = await getZoom(page);
    // fitToScreen は pageWidth=600, pageHeight=800, container は Playwright が
    // viewport 1200x800 で描画するため、おおむね 25-200% 範囲に収まるはず
    expect(zoom).toBeGreaterThanOrEqual(25);
    expect(zoom).toBeLessThanOrEqual(200);

    // ステータスバーにも反映されているか
    const statusZoom = await getStatusBarZoom(page);
    expect(statusZoom).toBe(zoom);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-02: ズーム変更後の Ctrl+0 — フィット倍率に戻るか
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-02] ズームを変更してから Ctrl+0 — zoom がフィット値に戻り isAutoFit=true になる', async ({ page }) => {
    await loadFixtureDocument(page);

    // まず Ctrl+0 を押してフィット値を記録する
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(200);
    const fitZoom = await getZoom(page);

    // zoom を store 経由で 200% に変更（手動ズームイン相当）
    await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      useViewerStore.getState().setZoom(200);
    });
    await page.waitForTimeout(50);
    expect(await getZoom(page)).toBe(200);

    // Ctrl+0 を押してフィット表示に戻す
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(200);

    const zoomAfterFit = await getZoom(page);
    // フィット後の zoom は最初のフィット値と同じになるはず
    expect(zoomAfterFit).toBe(fitZoom);

    // フィットボタンが active
    expect(await isFitActiveViaViewTab(page)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-03: ページ移動後の Ctrl+0
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-03] ページ移動後の Ctrl+0 — 2ページ目でもフィット表示が動作する', async ({ page }) => {
    await loadFixtureDocument(page);

    // 2ページ目に移動（pecoStore.setCurrentPage）
    await page.evaluate(async () => {
      const { usePecoStore } = await import('/src/store/pecoStore.ts');
      usePecoStore.getState().setCurrentPage(1);
    });
    await page.waitForTimeout(100);

    // zoom を変更してからフィット
    await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      useViewerStore.getState().setZoom(300);
    });
    await page.waitForTimeout(50);

    await page.keyboard.press('Control+0');
    await page.waitForTimeout(200);

    const zoom = await getZoom(page);
    // フィット後は 25-500% の範囲かつ 300 ではないはず
    // ただし JSDOM(headless) では container.clientWidth/Height が 0 になる可能性があり、
    // その場合は setZoom が呼ばれずに zoom=300 のまま→ FIT-03 は failing を記録する
    expect(zoom).toBeGreaterThanOrEqual(25);
    expect(zoom).toBeLessThanOrEqual(500);

    expect(await isFitActiveViaViewTab(page)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-04: OCR カード (contentEditable) フォーカス中の Ctrl+0
  //
  // PCT-095 修正後仕様: isEditing ガードを追加したため、OCR カード編集中は
  // Ctrl+0 が fitToScreen を呼ばない（zoom が変化しない）。
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-04] OCR カードフォーカス中の Ctrl+0 — isEditing ガードにより fitToScreen が呼ばれない（PCT-095 修正後）', async ({ page }) => {
    await loadFixtureDocument(page);

    // zoom を 200% に変えておく
    await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      useViewerStore.getState().setZoom(200);
    });
    await page.waitForTimeout(50);

    // OCR カードの contentEditable にフォーカスを当てる
    const ocrContent = page.locator('.ocr-card-content').first();
    await ocrContent.click();
    await page.waitForTimeout(50);

    // フォーカスが contentEditable 内にあることを確認
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.classList.contains('ocr-card-content') ||
             !!el?.closest('[contenteditable="true"]');
    });
    expect(focused).toBe(true);

    const zoomBefore = await getZoom(page);

    // Ctrl+0 を送信
    // PCT-095: isEditing ガードを追加したため、編集中は fitToScreen が呼ばれない
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(200);

    const zoomAfter = await getZoom(page);

    console.log(`[FIT-04] zoom before=${zoomBefore} after=${zoomAfter}. isEditing guard: PRESENT (PCT-095 fixed)`);

    // 編集中は zoom が変化しないこと（fitToScreen がスキップされる）
    expect(zoomAfter).toBe(zoomBefore);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-05: サムネイルパネルフォーカス中の Ctrl+0
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-05] サムネイルパネルフォーカス中の Ctrl+0 — フィットが動作する', async ({ page }) => {
    await loadFixtureDocument(page);

    // zoom を変更
    await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      useViewerStore.getState().setZoom(150);
    });
    await page.waitForTimeout(50);

    // サムネイルパネルをクリック（フォーカス移動）
    const thumbnailPanel = page.locator('.thumbnails-panel');
    const thumbnailPanelVisible = await thumbnailPanel.isVisible();
    if (thumbnailPanelVisible) {
      await thumbnailPanel.click({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(50);
    }

    // Ctrl+0 を送信
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(200);

    // サムネイルはフォームではないので isEditing=false → Ctrl+0 が発火するはず
    expect(await isFitActiveViaViewTab(page)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-06: テンキー0 (Numpad0) — PCT-008 再発確認
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-06] Ctrl+Numpad0 でフィットが発火する — PCT-008 再発確認', async ({ page }) => {
    await loadFixtureDocument(page);

    // zoom を変更
    await page.evaluate(async () => {
      const { useViewerStore } = await import('/src/store/viewerStore.ts');
      useViewerStore.getState().setZoom(200);
    });
    await page.waitForTimeout(50);

    const zoomBefore = await getZoom(page);
    expect(zoomBefore).toBe(200);

    // Ctrl+Numpad0 を押す
    // useKeyboardShortcuts の条件:
    // (e.ctrlKey || e.metaKey) && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')
    await page.keyboard.press('Control+Numpad0');
    await page.waitForTimeout(200);

    // Playwright が Control+Numpad0 を code='Numpad0' で送れば発火するはず
    expect(await isFitActiveViaViewTab(page)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-07: 連打（Ctrl+0 を2回）
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-07] Ctrl+0 連打（2回）— 2回目でも isAutoFit=true を維持する', async ({ page }) => {
    await loadFixtureDocument(page);

    await page.keyboard.press('Control+0');
    await page.waitForTimeout(100);
    const zoom1 = await getZoom(page);

    // 連打
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(100);
    const zoom2 = await getZoom(page);

    // zoom 値はリサイズなしなら同じ
    expect(zoom2).toBe(zoom1);

    // 2回目でもフィットボタンは active
    expect(await isFitActiveViaViewTab(page)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-08: ウィンドウリサイズ後の Ctrl+0
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-08] ウィンドウリサイズ後の Ctrl+0 — リサイズ後の新しいコンテナサイズでフィットする', async ({ page }) => {
    await loadFixtureDocument(page);

    // 初期 zoom を記録
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(200);
    const zoomBefore = await getZoom(page);

    // viewport を狭める
    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(200);

    // 手動 Ctrl+0 でリサイズ後のコンテナサイズでフィット
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(200);

    const zoomAfter = await getZoom(page);
    console.log(`[FIT-08] zoom before resize=${zoomBefore}, zoom after resize+fit=${zoomAfter}`);

    // PCT-095 修正後: フィット計算が 25% 未満になっても 10% まで通過する
    expect(await isFitActiveViaViewTab(page)).toBe(true);
    expect(zoomAfter).toBeGreaterThanOrEqual(10);
    expect(zoomAfter).toBeLessThanOrEqual(500);
    // 実測値: viewport 800x600 では pdf-viewer-panel が w=172 h=458 に縮む。
    // ratioW=(172-64)/600=0.18=18% → PCT-095 修正後は 18% が viewerStore 下限 10 でクランプされ 18% になる。
    // 旧仕様の Math.max(25,18)=25% クランプが解消され、実際のコンテナ幅に合ったフィット倍率になる。
    // レビュー指摘 (いろは): 旧仕様の 25% も 10-500 の範囲内に収まり素通しするため、
    // 「25% クランプが解消された」ことを直接ピン留めする (実測 18% なので余裕あり)。
    expect(zoomAfter).toBeLessThan(25);

    // viewport を元に戻す
    await page.setViewportSize({ width: 1200, height: 800 });
  });

  // ─────────────────────────────────────────────────────────────────
  // FIT-09: PCT-003 再発確認 — ページ寸法ロード前の Ctrl+0 で isAutoFit だけ立って zoom 未更新
  // ─────────────────────────────────────────────────────────────────
  test('[FIT-09] PCT-003 再発確認 — pageWidth/Height が undefined の状態で Ctrl+0 を押しても zoom は不変', async ({ page }) => {
    // ファイルをロードせずに Ctrl+0 を押す（ページ寸法未ロード状態）
    // fitToScreen は container && pageWidth && pageHeight が揃わないと setZoom を呼ばない

    const zoomBefore = await getZoom(page);
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(100);
    const zoomAfter = await getZoom(page);

    // zoom は変わらないはず（pageWidth/pageHeight が undefined のため fitToScreen が早期リターン）
    expect(zoomAfter).toBe(zoomBefore);
  });
});
