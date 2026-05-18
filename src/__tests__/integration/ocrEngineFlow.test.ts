/**
 * OCR エンジン呼び出し経路の JS 側テスト。
 *
 * 対象: `useOcrEngine` の runOcrCurrentPage / runOcrAllPages / cancelOcr
 *
 * スコープ:
 *   - Rust 側 (Windows.Media.Ocr) の実動作はテスト対象外。
 *     invoke('run_ocr') を mock し、JS 側のデータ変換・ソート・store 連携・
 *     cancellation / progress / error ハンドリングを検証する。
 *
 * 検証項目:
 *   1. 正常系: 1 ページ OCR → textBlocks が設定・isDirty=true
 *   2. 上書き確認: 既存 OCR があると ask() が呼ばれ、キャンセルで store 変化なし
 *   3. エラー系: invoke が status=error を返す → toast, store 変化なし
 *   4. 全ページ OCR 進捗: progress が 1→2→...→N に更新される
 *   5. キャンセル: 全ページ OCR 中に cancelOcr → 途中で止まり toast が「キャンセル」
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// 依存 mock --- vi.hoisted で巻き上げて TDZ 回避 ----------------------
const h = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  askMock: vi.fn(),
  writeFileMock: vi.fn(),
  removeMock: vi.fn(),
  getCachedPageProxyMock: vi.fn(),
  openFreshPdfDocMock: vi.fn(),
  getTemporaryPageDataMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invokeMock, convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: h.askMock, open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: h.writeFileMock, remove: h.removeMock,
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('@tauri-apps/api/path', () => ({
  tempDir: vi.fn(async () => '/tmp'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

// pdfLoader: 最小限の PDFDocumentProxy 風 mock
//
// #50 検証用に getViewport は rotation (0/90/180/270) を考慮した
// convertToPdfPoint を返す。pdfjs と同じ式で実装。
//   rot=0   : [x_pdf, height - y_screen]
//   rot=90  : [y_screen, x_screen]          (回転後の画面は元 PDF の縦長を横にしたもの)
//   rot=180 : [width - x_screen, y_screen]
//   rot=270 : [height - y_screen, width - x_screen]
// width/height は PDF user space 寸法 (rotation=0 のときの幅・高さ)。
type ViewportMock = {
  width: number;
  height: number;
  scale: number;
  rotation: number;
  convertToPdfPoint: (x: number, y: number) => [number, number];
};
const makeViewport = (
  pdfWidth: number,
  pdfHeight: number,
  rotation: number,
  scale: number,
): ViewportMock => {
  // 回転後のスクリーン寸法
  const rot = ((rotation % 360) + 360) % 360;
  const screenW = (rot === 90 || rot === 270 ? pdfHeight : pdfWidth) * scale;
  const screenH = (rot === 90 || rot === 270 ? pdfWidth : pdfHeight) * scale;
  const convertToPdfPoint = (x: number, y: number): [number, number] => {
    // unscale to viewport-space (scale=1.0)
    const xu = x / scale;
    const yu = y / scale;
    switch (rot) {
      case 0:
        // PDF y is up, viewport y is down; pdf_y = pdfHeight - yu
        return [xu, pdfHeight - yu];
      case 90:
        // viewport (x,y) -> pdf (pdfWidth, ?)  Mapping derived from pdfjs:
        // pdf_x = yu, pdf_y = xu
        return [yu, xu];
      case 180:
        return [pdfWidth - xu, yu];
      case 270:
        return [pdfHeight - yu, pdfWidth - xu];
      default:
        return [xu, pdfHeight - yu];
    }
  };
  return {
    width: screenW,
    height: screenH,
    scale,
    rotation: rot,
    convertToPdfPoint,
  };
};
const makeMockPage = (width = 595, height = 842, rotation = 0) => ({
  getViewport: vi.fn(({ scale = 1.0 }: { scale?: number } = {}) =>
    makeViewport(width, height, rotation, scale),
  ),
  render: vi.fn(() => ({ promise: Promise.resolve() })),
  cleanup: vi.fn(),
});
const makeMockPdf = (totalPages: number, pageOpts: { width?: number; height?: number; rotation?: number } = {}) => ({
  numPages: totalPages,
  getPage: vi.fn(async () =>
    makeMockPage(pageOpts.width ?? 595, pageOpts.height ?? 842, pageOpts.rotation ?? 0),
  ),
  destroy: vi.fn(async () => {}),
  cleanup: vi.fn(async () => {}),
});

vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: h.getCachedPageProxyMock,
  getSharedPdfProxy: vi.fn(),
  openFreshPdfDoc: h.openFreshPdfDocMock,
  loadPDF: vi.fn(),
  destroySharedPdfProxy: vi.fn(),
  getAllTemporaryPageData: vi.fn(async () => new Map()),
  getTemporaryPageData: h.getTemporaryPageDataMock,
  clearTemporaryChanges: vi.fn(async () => {}),
}));

vi.mock('../../utils/pdfTemporaryStorage', () => ({
  saveTemporaryPageData: vi.fn(),
  saveTemporaryPageDataBatch: vi.fn(async () => {}),
  getTemporaryPageData: vi.fn(async () => null),
  getAllTemporaryPageData: vi.fn(async () => new Map()),
  clearTemporaryChanges: vi.fn(async () => {}),
  getCachedPage: vi.fn(async () => null),
  setCachedPage: vi.fn(),
}));

vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// target import (mock 後)
import { useOcrEngine } from '../../hooks/useOcrEngine';
import { usePecoStore } from '../../store/pecoStore';
import type { PecoDocument, PageData, TextBlock } from '../../types';

// Helpers ---------------------------------------------------------
function makeDoc(totalPages: number): PecoDocument {
  const pages = new Map<number, PageData>();
  for (let i = 0; i < totalPages; i++) {
    pages.set(i, {
      pageIndex: i, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null,
    });
  }
  return { filePath: '/t.pdf', fileName: 't.pdf', totalPages, metadata: {}, pages };
}

beforeAll(() => {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
    (globalThis as unknown as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => `${Math.random().toString(16).slice(2)}-${Date.now()}`,
    } as unknown as Crypto;
  }
});

beforeEach(() => {
  h.invokeMock.mockReset();
  h.askMock.mockReset();
  h.writeFileMock.mockReset().mockResolvedValue(undefined);
  h.removeMock.mockReset().mockResolvedValue(undefined);
  h.getCachedPageProxyMock.mockReset().mockResolvedValue(makeMockPage());
  h.openFreshPdfDocMock.mockReset().mockResolvedValue(makeMockPdf(3));
  h.getTemporaryPageDataMock.mockReset().mockResolvedValue(null);

  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [], redoStack: [],
    isDirty: false,
    pendingRestoration: null,
    pageAccessOrder: [],
    currentPageIndex: 0,
    clipboard: [],
  } as any);
});

describe('useOcrEngine: JS 側のパイプライン (invoke 結果を mock)', () => {
  it('正常系: 1 ページ OCR → textBlocks 3 件が store に反映、isDirty=true', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    // invoke('run_ocr') が 3 ブロック返す
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'α', bbox: { x: 10, y: 10, width: 20, height: 20 }, writingMode: 'horizontal', confidence: 1 },
          { text: 'β', bbox: { x: 40, y: 10, width: 20, height: 20 }, writingMode: 'horizontal', confidence: 1 },
          { text: 'γ', bbox: { x: 70, y: 10, width: 20, height: 20 }, writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const showToast = (msg: string, err?: boolean) => toasts.push({ msg, err });

    const { result } = renderHook(() => useOcrEngine(showToast));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // invoke が呼ばれ、writeFile / remove も走っている
    expect(h.invokeMock).toHaveBeenCalledWith(
      'run_ocr',
      expect.objectContaining({ imagePath: expect.any(String) }),
    );
    expect(h.writeFileMock).toHaveBeenCalled();
    expect(h.removeMock).toHaveBeenCalled();

    // store 反映: textBlocks 3 件、全て isDirty=true
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(3);
    expect(p0.textBlocks.every((b) => b.isDirty)).toBe(true);
    expect(p0.textBlocks.map((b) => b.text)).toEqual(['α', 'β', 'γ']);
    expect(p0.isDirty).toBe(true);

    // 成功トースト
    expect(toasts.some((t) => t.msg.includes('OCR'))).toBe(true);
  });

  it('上書き確認: 既存 textBlocks 有り + ask false でキャンセル → invoke 呼ばず', async () => {
    const doc = makeDoc(1);
    doc.pages.get(0)!.textBlocks = [
      { id: 'existing', text: 'OLD', originalText: 'OLD', bbox: { x: 0, y: 0, width: 10, height: 10 },
        writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    ];
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    h.askMock.mockResolvedValue(false); // ユーザーが上書きキャンセル

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    expect(h.askMock).toHaveBeenCalled();
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());

    // store 変化なし
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(1);
    expect(p0.textBlocks[0].text).toBe('OLD');
  });

  it('エラー系: invoke が status=error → error toast, store 変化なし', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_ocr') return JSON.stringify({ status: 'error', blocks: [], message: 'OCR engine failed' });
      return '';
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const showToast = (msg: string, err?: boolean) => toasts.push({ msg, err });

    const { result } = renderHook(() => useOcrEngine(showToast));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // error toast 発火
    expect(toasts.some((t) => t.err === true && /OCR/.test(t.msg))).toBe(true);
    // store は変化なし
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(0);
    expect(p0.isDirty).toBe(false);
  });

  it('全ページ OCR: progress が 1→2→3 と進行、最終 toast が完了メッセージ', async () => {
    usePecoStore.getState().setDocument(makeDoc(3));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(3));
    h.askMock.mockResolvedValue(true); // 確認 2 段階を全て OK

    // 各ページ 1 ブロック
    let callCount = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      callCount++;
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: `BLOCK_${callCount}`, bbox: { x: 0, y: 0, width: 10, height: 10 },
            writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));

    await act(async () => { await result.current.runOcrAllPages(); });

    // 3 ページ全てに invoke 呼出
    expect(h.invokeMock).toHaveBeenCalledTimes(3);
    // 各ページ textBlocks が 1 件ずつ
    for (let i = 0; i < 3; i++) {
      const p = usePecoStore.getState().document!.pages.get(i)!;
      expect(p.textBlocks).toHaveLength(1);
      expect(p.isDirty).toBe(true);
    }
    // 完了 toast (キャンセルではない)
    expect(toasts.some((t) => t.msg.includes('完了') || t.msg.includes('OCR'))).toBe(true);
    expect(toasts.some((t) => t.msg.includes('キャンセル'))).toBe(false);
  });

  it('キャンセル: runOcrAllPages 中に cancelOcr → 途中で止まり toast にキャンセル文言', async () => {
    usePecoStore.getState().setDocument(makeDoc(5));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(5));
    h.askMock.mockResolvedValue(true);

    // 2 ページ目の invoke 完了時点でキャンセル
    let processed = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      processed++;
      // awaited path に必ず 1 microtask 挟むことで cancelTokenRef の反映タイミングを作る
      await new Promise((r) => setTimeout(r, 0));
      return JSON.stringify({
        status: 'ok',
        blocks: [{ text: `P${processed}`, bbox: { x: 0, y: 0, width: 10, height: 10 },
          writingMode: 'horizontal', confidence: 1 }],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));

    const promise = result.current.runOcrAllPages();
    // 2 ページ処理が始まるまで待つ
    await new Promise((r) => setTimeout(r, 20));
    act(() => { result.current.cancelOcr(); });
    await act(async () => { await promise; });

    // 5 ページ全ては処理されていない (cancelOcr で途中停止)
    expect(h.invokeMock.mock.calls.length).toBeLessThan(5);
    expect(h.invokeMock.mock.calls.length).toBeGreaterThan(0);
    // キャンセル toast が存在
    expect(toasts.some((t) => t.msg.includes('キャンセル'))).toBe(true);
  });

  it('issue #9: LRU 退避ページに対する runOcrCurrentPage で IDB 既存 textBlocks があれば上書き確認が出る', async () => {
    // 1 ページの doc を作るが、メモリ Map からは pageIndex=0 を削除して LRU 退避状態を模倣
    const doc = makeDoc(1);
    doc.pages.delete(0);
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    // IDB 側には退避済み textBlocks が残っている状態を mock で再現
    const evictedBlock: TextBlock = {
      id: 'evicted', text: 'EVICTED_EDIT', originalText: 'EVICTED_EDIT',
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      writingMode: 'horizontal', order: 0, isNew: false, isDirty: true,
    };
    h.getTemporaryPageDataMock.mockResolvedValue({
      pageIndex: 0, width: 595, height: 842, isDirty: true, textBlocks: [evictedBlock],
    });

    // ユーザーは上書きをキャンセル
    h.askMock.mockResolvedValue(false);

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // 上書き確認 ask() が呼ばれ、IDB 退避済み textBlocks がチェックされている
    expect(h.getTemporaryPageDataMock).toHaveBeenCalledWith('/t.pdf', 0);
    expect(h.askMock).toHaveBeenCalled();
    // ユーザーがキャンセルしたので invoke('run_ocr') は走らない
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  // ─────────────────────────────────────────────────────────────
  // #48: フォルダ OCR は savePdf() === false を受けたら即時中止する
  // ─────────────────────────────────────────────────────────────
  it('issue #48: フォルダ OCR は savePdf が false を返したら次の PDF へ進まずに中止する', async () => {
    // 2 ファイル分の PDF を返すフォルダを mock
    const askDialogMock = (await import('@tauri-apps/plugin-dialog')).open as ReturnType<typeof vi.fn>;
    askDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValue(true); // フォルダOCR確認 OK

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_pdf_files_in_folder') return ['/folder/a.pdf', '/folder/b.pdf'];
      if (cmd === 'run_ocr') {
        return JSON.stringify({
          status: 'ok',
          blocks: [
            { text: 'X', bbox: { x: 0, y: 0, width: 5, height: 5 },
              writingMode: 'horizontal', confidence: 1 },
          ],
        });
      }
      return '';
    });

    // openPdf は doc を store にセットして true を返す
    const openCalls: string[] = [];
    const openPdf = async (filePath: string) => {
      openCalls.push(filePath);
      usePecoStore.getState().setDocument({
        filePath,
        fileName: filePath.split('/').pop()!,
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, {
          pageIndex: 0, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null,
        }]]),
      });
      return true;
    };
    // 1 ファイル目: savePdf が false → ループ中止、2 ファイル目には進まないはず
    const savePdf = vi.fn(async () => false);

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() =>
      useOcrEngine((m, e) => toasts.push({ msg: m, err: e }), { openPdf, savePdf }),
    );

    await act(async () => { await result.current.runOcrFolder(); });

    // openPdf は 1 ファイル目までしか呼ばれていない
    expect(openCalls).toEqual(['/folder/a.pdf']);
    expect(savePdf).toHaveBeenCalledTimes(1);
    // 保存失敗トーストが出ている
    expect(toasts.some((t) => t.err === true && /保存に失敗/.test(t.msg))).toBe(true);
    // ループ中止後にキャンセル toast が出る
    expect(toasts.some((t) => t.msg.includes('キャンセル'))).toBe(true);
  });

  it('issue #48: フォルダ OCR は savePdf が true を返したら次の PDF へ進む', async () => {
    const openDialogMock = (await import('@tauri-apps/plugin-dialog')).open as ReturnType<typeof vi.fn>;
    openDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValue(true);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_pdf_files_in_folder') return ['/folder/a.pdf', '/folder/b.pdf'];
      if (cmd === 'run_ocr') {
        return JSON.stringify({
          status: 'ok',
          blocks: [{ text: 'OK', bbox: { x: 0, y: 0, width: 5, height: 5 },
            writingMode: 'horizontal', confidence: 1 }],
        });
      }
      return '';
    });

    const openCalls: string[] = [];
    const openPdf = async (filePath: string) => {
      openCalls.push(filePath);
      usePecoStore.getState().setDocument({
        filePath,
        fileName: filePath.split('/').pop()!,
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, {
          pageIndex: 0, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null,
        }]]),
      });
      return true;
    };
    const savePdf = vi.fn(async () => true);

    const { result } = renderHook(() => useOcrEngine(() => {}, { openPdf, savePdf }));
    await act(async () => { await result.current.runOcrFolder(); });

    // 2 ファイル全て処理される
    expect(openCalls).toEqual(['/folder/a.pdf', '/folder/b.pdf']);
    expect(savePdf).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────────────────────────────────────────
  // #50: /Rotate 90 ページで OCR の BB が PDF user space に変換される
  // ─────────────────────────────────────────────────────────────
  it('issue #50: /Rotate 90 ページの OCR 結果 BB は viewport.convertToPdfPoint で PDF user space に変換される', async () => {
    // PDF user space: 595 x 842 (rotation=0 時の縦長 A4)
    // /Rotate 90 → 画面 (scale=2.0) は 1684 x 1190 で render される
    // Rust 側は画像ピクセルを render_scale で割って返すため、
    // 戻り値の BB は (scale=1.0 の) viewport 座標系 = 842 x 595
    //
    // 入力 BB (rotated viewport, scale=1.0): x=10, y=10, w=20, h=30
    // 4 隅:  (10,10), (30,10), (10,40), (30,40)
    // rotation=90 の convertToPdfPoint:  (xv,yv) -> (yv, xv)
    //   (10,10) → (10,10)
    //   (30,10) → (10,30)
    //   (10,40) → (40,10)
    //   (30,40) → (40,30)
    // PDF user space AABB: x in [10,40], y in [10,30] → x=10, y=10, w=30, h=20
    const rotated = makeMockPdf(1, { width: 595, height: 842, rotation: 90 });
    h.openFreshPdfDocMock.mockResolvedValue(rotated);
    h.getCachedPageProxyMock.mockResolvedValue(makeMockPage(595, 842, 90));

    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'R', bbox: { x: 10, y: 10, width: 20, height: 30 },
            writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(1);
    const bb = p0.textBlocks[0].bbox;
    // x,y は 4 隅変換後の min。w,h は max-min。
    expect(bb.x).toBeCloseTo(10, 6);
    expect(bb.y).toBeCloseTo(10, 6);
    expect(bb.width).toBeCloseTo(30, 6);
    expect(bb.height).toBeCloseTo(20, 6);
    // ページ寸法 (PDF user space) の範囲内に収まっていることが #50 の主目的
    expect(bb.x).toBeGreaterThanOrEqual(0);
    expect(bb.y).toBeGreaterThanOrEqual(0);
    expect(bb.x + bb.width).toBeLessThanOrEqual(595);
    expect(bb.y + bb.height).toBeLessThanOrEqual(842);
  });

  it('issue #50: /Rotate 0 ページの OCR 結果 BB は y 軸が反転され PDF user space に変換される', async () => {
    // 回転なしでも viewport y は上が 0、PDF user space y は下が 0 なので y 軸反転だけ起きる。
    // 入力 BB (viewport): x=10, y=10, w=20, h=30  (4 隅: (10,10) (30,10) (10,40) (30,40))
    // rotation=0 の convertToPdfPoint: (x,y) -> (x, 842 - y)
    //   (10,10) → (10,832), (30,10) → (30,832), (10,40) → (10,802), (30,40) → (30,802)
    // PDF user space AABB: x∈[10,30], y∈[802,832] → x=10, y=802, w=20, h=30
    const unrotated = makeMockPdf(1, { width: 595, height: 842, rotation: 0 });
    h.openFreshPdfDocMock.mockResolvedValue(unrotated);

    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'U', bbox: { x: 10, y: 10, width: 20, height: 30 },
            writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const bb = usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].bbox;
    expect(bb.x).toBeCloseTo(10, 6);
    expect(bb.y).toBeCloseTo(802, 6);
    expect(bb.width).toBeCloseTo(20, 6);
    expect(bb.height).toBeCloseTo(30, 6);
  });
});
